"""任务接入服务（FR-PRE-01）：BugTicketData 标准化入库并创建任务实例。

幂等：以 platform + platform_bug_id 去重；已接入的 Bug 会用最新平台数据刷新字段。
若任务正处 WAIT_INFO（等待人工补充）且数据有变化，自动唤醒重新进入完整性分析
（平台侧信息补充自动回流，FR-PRE-02）。
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from autobugfixer.platform import BugTicketData
from autobugfixer.core.models import BugTicket, Intervention, Task, TaskStateHistory
from autobugfixer.core.state import TaskState, assert_transition
from autobugfixer.core.audit import AuditService
from autobugfixer.ingest.repo_check import repo_check_summary, sync_bug_repos


def ingest_bug(session: Session, data: BugTicketData, max_retry: int = 3) -> tuple[Task, bool]:
    """把平台 Bug 转换为标准任务对象。返回 (task, created)。

    - 新 Bug：创建 BugTicket + 任务实例（DISCOVERED -> ANALYZING）；
    - 已存在：刷新字段；若任务正处 WAIT_INFO 且数据有变化，唤醒重新分析；
    - 脏数据兜底：存在 BugTicket 但缺任务时补建任务，避免返回 None；
    - 仓库校验（Spec 01 §9）：入库前逐仓库纯本地校验并持久化 bug_repo 行，
      task_ingest 审计携带 repo_check 摘要；不可用任务由完整性阶段拦下
      （进入分析前停 WAIT_INFO，0 次 LLM 调用）。
    """
    audit = AuditService(session)
    existing = session.scalar(select(BugTicket).where(
        BugTicket.platform == data.platform,
        BugTicket.platform_bug_id == data.platform_bug_id))
    if existing is not None:
        changed = _refresh_bug(existing, data)
        sync_bug_repos(session, existing, data)  # 重导复检（Spec 01 §9.4）
        task = session.scalar(select(Task).where(Task.bug_ticket_id == existing.id))
        if task is None:
            # 脏数据兜底：补建任务实例
            task = _create_task(session, existing, max_retry)
            audit.log(action="task_recreated", target=f"bug:{existing.platform_bug_id}",
                      detail={"task_id": task.id}, task_id=task.id)
        elif changed and TaskState(task.state) == TaskState.WAIT_INFO:
            _wake_wait_info(session, task, audit)
        return task, False

    bug = BugTicket(
        platform=data.platform, platform_bug_id=data.platform_bug_id,
        title=data.title, description=data.description, repro_steps=data.repro_steps,
        expected=data.expected, actual=data.actual, env_version=data.env_version,
        attachments=data.attachments, repo_url=data.repo_url, repo_branch=data.repo_branch,
        affected_modules=data.affected_modules, missing_fields=data.missing_fields,
        raw_payload=data.raw_payload, synced_at=datetime.now(timezone.utc),
    )
    session.add(bug)
    session.flush()
    repo_rows = sync_bug_repos(session, bug, data)  # 接入时校验一次（Spec 01 §9.3）
    task = _create_task(session, bug, max_retry)
    audit.log(action="task_ingest", target=f"task:{task.id}",
              detail={"platform": data.platform, "bug_id": data.platform_bug_id,
                      "missing_fields": data.missing_fields,
                      "repo_check": repo_check_summary(repo_rows)},
              task_id=task.id)
    session.flush()
    return task, True


def _refresh_bug(bug: BugTicket, data: BugTicketData) -> bool:
    """用最新平台数据刷新 BugTicket 字段；返回是否有实质变化（供唤醒判断）。"""
    updates = {
        "title": data.title,
        "description": data.description,
        "repro_steps": data.repro_steps,
        "expected": data.expected,
        "actual": data.actual,
        "env_version": data.env_version,
        "attachments": data.attachments,
        "repo_url": data.repo_url,
        "repo_branch": data.repo_branch,
        "affected_modules": data.affected_modules,
        "missing_fields": data.missing_fields,
        "raw_payload": data.raw_payload,
    }
    changed = False
    for key, value in updates.items():
        if getattr(bug, key) != value:
            setattr(bug, key, value)
            changed = True
    if changed:
        bug.synced_at = datetime.now(timezone.utc)
    return changed


def _create_task(session: Session, bug: BugTicket, max_retry: int) -> Task:
    """为 BugTicket 创建任务实例并写入 DISCOVERED -> ANALYZING 的完整状态历史。"""
    task = Task(bug_ticket_id=bug.id, state=TaskState.DISCOVERED.value,
                max_retry=max_retry, current_stage="ingest")
    session.add(task)
    session.flush()
    for from_state, to_state, msg in [
        (None, TaskState.DISCOVERED, "Bug 接入标准化完成"),
        (TaskState.DISCOVERED, TaskState.ANALYZING, "进入完整性分析"),
    ]:
        session.add(TaskStateHistory(
            task_id=task.id, from_state=from_state.value if from_state else None,
            to_state=to_state.value, stage="ingest", message=msg))
    task.state = TaskState.ANALYZING.value
    session.flush()
    return task


def _wake_wait_info(session: Session, task: Task, audit: AuditService) -> None:
    """平台侧数据更新：唤醒 WAIT_INFO 任务重新进入完整性分析（状态机校验 + 留痕）。

    同时关闭该任务仍待处理的信息补充介入单，避免看板残留过期待办；
    info_rounds 与介入回写路径口径一致递增，防止反复轮询导致补充死循环。
    """
    from_state = TaskState(task.state)
    assert_transition(from_state, TaskState.ANALYZING)
    task.state = TaskState.ANALYZING.value
    task.current_stage = "ingest"
    task.info_rounds += 1
    now = datetime.now(timezone.utc)
    session.add(TaskStateHistory(
        task_id=task.id, from_state=from_state.value, to_state=TaskState.ANALYZING.value,
        stage="ingest", message="平台侧数据更新，重新进入完整性分析"))
    for it in session.scalars(select(Intervention).where(
            Intervention.task_id == task.id,
            Intervention.type.in_(["info_supplement", "repo_supplement"]),
            Intervention.status == "pending")).all():
        it.status = "resolved"
        it.result = {"note": "平台侧数据已更新，系统自动唤醒任务", "fields": "platform_sync"}
        it.resolved_at = now
    audit.log(action="task_resynced", target=f"task:{task.id}",
              detail={"bug_ticket_id": task.bug_ticket_id, "info_rounds": task.info_rounds},
              task_id=task.id)
