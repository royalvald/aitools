"""任务接入服务（FR-PRE-01）：BugTicketData 标准化入库并创建任务实例。

幂等：以 platform + platform_bug_id 去重；平台侧更新触发重新分析。
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..adapters.bug_platform import BugTicketData
from ..models import BugTicket, Task, TaskStateHistory
from ..pipeline.state import TaskState
from .audit import AuditService


def ingest_bug(session: Session, data: BugTicketData, max_retry: int = 3) -> tuple[Task, bool]:
    """把平台 Bug 转换为标准任务对象。返回 (task, created)。"""
    existing = session.scalar(select(BugTicket).where(
        BugTicket.platform == data.platform,
        BugTicket.platform_bug_id == data.platform_bug_id))
    audit = AuditService(session)
    if existing is not None:
        # 幂等：已接入的 Bug 直接返回既有任务
        task = session.scalar(select(Task).where(Task.bug_ticket_id == existing.id))
        return task, False  # type: ignore[return-value]

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

    task = Task(bug_ticket_id=bug.id, state=TaskState.DISCOVERED.value,
                max_retry=max_retry, current_stage="ingest")
    session.add(task)
    session.flush()
    # DISCOVERED -> ANALYZING：入库即进入分析，状态历史完整留痕
    for from_state, to_state, msg in [
        (None, TaskState.DISCOVERED, "Bug 接入标准化完成"),
        (TaskState.DISCOVERED, TaskState.ANALYZING, "进入完整性分析"),
    ]:
        session.add(TaskStateHistory(
            task_id=task.id, from_state=from_state.value if from_state else None,
            to_state=to_state.value, stage="ingest", message=msg))
    task.state = TaskState.ANALYZING.value
    audit.log(action="task_ingest", target=f"task:{task.id}",
              detail={"platform": data.platform, "bug_id": data.platform_bug_id,
                      "missing_fields": data.missing_fields}, task_id=task.id)
    session.flush()
    return task, True
