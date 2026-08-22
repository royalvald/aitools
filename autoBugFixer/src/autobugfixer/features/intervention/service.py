"""人工介入服务（设计文档 4.5，PRD 第八章）。

统一介入模型：Stage 返回 need_intervention -> 创建介入单 -> 任务置 WAIT_* 阻塞态；
处理结果回写 -> 触发任务按类型续跑。超时升级为调度器职责（status=timeout）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from autobugfixer.features.intervention.notifier import NoticeMessage, Notifier
from autobugfixer.common.core.models import BugTicket, Intervention, Task, VerificationPlan
from autobugfixer.common.core.stage import InterventionRequest
from autobugfixer.common.core.state import TaskState
from autobugfixer.common.core.audit import AuditService

# 介入类型 -> 默认处理角色
TYPE_TO_ROLE = {
    "info_supplement": "tester",
    "repo_supplement": "tester",
    "plan_confirm": "tech_lead",
    "discussion": "developer",
    "optimization": "tech_lead",
}


class InterventionService:
    """人工介入服务：创建介入单、处理结果回写并驱动任务续跑。"""

    def __init__(self, session: Session, notifier: Notifier | None = None,
                 writeback=None, sla_hours: float | None = None) -> None:
        self.session = session
        self.notifier = notifier
        self.audit = AuditService(session)
        # 状态迁移后的平台回写钩子（由 Orchestrator 注入，可选）
        self._writeback = writeback
        # SLA（PRD 第八章）：创建介入单时填充 deadline，供调度器超时升级扫描
        self._sla_hours = sla_hours

    def create(self, task_id: int, request: InterventionRequest) -> Intervention:
        """创建介入单并推送通知（任务置阻塞态由 Orchestrator 完成）。

        deadline = 创建时刻 + SLA 时长（调度器超时升级扫描的依据）；
        未配置 SLA 时留空（不参与超时升级）。
        """
        intervention = Intervention(
            task_id=task_id,
            type=request.type,
            title=request.title,
            context=request.context,
            assignee_role=request.assignee_role or TYPE_TO_ROLE.get(request.type, "developer"),
            status="pending",
            deadline=(datetime.now(timezone.utc) + timedelta(hours=self._sla_hours))
            if self._sla_hours else None,
            notified_at=datetime.now(timezone.utc),
        )
        self.session.add(intervention)
        self.session.flush()
        self.audit.log(action="intervention_create", target=f"intervention:{intervention.id}",
                       detail={"type": request.type, "title": request.title}, task_id=task_id)
        if self.notifier is not None:
            self.notifier.send(intervention.assignee_role, NoticeMessage(
                title=f"[介入请求] {request.title}",
                content=str(request.context)[:500],
                link=f"/interventions/{intervention.id}",
            ))
        return intervention

    def _transition_task(self, task: Task, to_state: TaskState, message: str) -> None:
        """介入回写引发的任务状态迁移（统一走 core.transitions，保证留痕完整）。"""
        from autobugfixer.common.core.transitions import transition_task

        transition_task(self.session, task, to_state, stage="intervention",
                        message=message, audit=self.audit, writeback=self._writeback)

    def resolve(self, intervention_id: int, result: dict, actor: str = "human") -> Task:
        """介入处理回写：写结果、按介入类型驱动任务续跑，返回所属任务。

        result 约定：
        - info_supplement: {"fields": {bug 字段补充}}
        - repo_supplement: {"fields": {"repo_url": "...", "repo_branch": "..."}}（Spec 01 §9）
        - plan_confirm:    {"approved": bool, "steps"?: [调整后的 DSL 步骤]}
        - discussion:      {"action": "manual_fix" | "close" | "retry"}
        """
        intervention = self.session.get(Intervention, intervention_id)
        if intervention is None:
            raise KeyError(f"介入单不存在: {intervention_id}")
        if intervention.status != "pending":
            raise ValueError(f"介入单状态不可回写: {intervention.status}")
        # 优化评审等系统级介入单不绑定任务（task_id=0）
        task = self.session.get(Task, intervention.task_id) if intervention.task_id else None

        intervention.status = "resolved"
        intervention.result = result
        intervention.resolved_at = datetime.now(timezone.utc)
        self.audit.log(action="intervention_resolve", target=f"intervention:{intervention_id}",
                       detail={"type": intervention.type, "result": result, "actor": actor},
                       task_id=task.id if task else None)

        if intervention.type == "info_supplement":
            assert task is not None, "信息补充介入单缺少关联任务"
            bug = self.session.get(BugTicket, task.bug_ticket_id)
            for key, value in result.get("fields", {}).items():
                if hasattr(bug, key):
                    setattr(bug, key, value)
            task.info_rounds += 1
            self._transition_task(task, TaskState.ANALYZING, "信息已补充，重新进入完整性分析")

        elif intervention.type == "repo_supplement":
            # 仓库补充回写（Spec 01 §9.4）：合并字段 -> 复检 -> 回 ANALYZING 由阶段门禁放行
            assert task is not None, "仓库补充介入单缺少关联任务"
            bug = self.session.get(BugTicket, task.bug_ticket_id)
            for key, value in result.get("fields", {}).items():
                if hasattr(bug, key):
                    setattr(bug, key, value)
            from autobugfixer.features.ingest.repo_check import sync_bug_repos

            sync_bug_repos(self.session, bug, bug_data_of(bug))
            task.info_rounds += 1
            self._transition_task(task, TaskState.ANALYZING, "仓库信息已补充，重新校验")

        elif intervention.type == "plan_confirm":
            assert task is not None, "方案确认介入单缺少关联任务"
            if not result.get("approved", False):
                self._transition_task(task, TaskState.MANUAL, "方案未获确认，转人工处理")
            else:
                plan = self.session.scalar(select(VerificationPlan).where(
                    VerificationPlan.task_id == task.id).order_by(VerificationPlan.version.desc()))
                if plan is not None:
                    if result.get("steps") is not None:
                        # 人工调整后的步骤落回 DSL：与生成期同强度校验
                        # （词表/必填参数/最少步数/必含断言），阻断免检弱方案
                        plan.steps = _validate_adjusted_steps(result["steps"])
                        plan.version += 1
                    plan.confirmed_by = actor
                    plan.confirmed_at = datetime.now(timezone.utc)
                self._transition_task(task, TaskState.SCORED, "方案已确认，进入评分")

        elif intervention.type == "discussion":
            assert task is not None, "失败讨论介入单缺少关联任务"
            action = result.get("action", "manual_fix")
            target = {"manual_fix": TaskState.MANUAL, "close": TaskState.CLOSED,
                      "retry": TaskState.FIXING}.get(action)
            if target is None:
                raise ValueError(f"未知 discussion 处理动作: {action}")
            if action == "retry":
                task.retry_count = 0  # 人工决定重试：重置重试计数（FR-MEM-02）
            self._transition_task(task, target, f"失败讨论结论: {action}")

        elif intervention.type == "optimization":
            # 自我优化评审（FR-SYS-02）：批准后策略写入版本化表并生效
            if result.get("approved", False):
                from autobugfixer.features.optimization.service import apply_strategy

                apply_strategy(self.session, intervention, actor=actor)

        else:  # 其他 P2 类型：仅回写，不驱动任务
            pass

        self.session.flush()
        return task

    def list_pending(self, assignee: str | None = None) -> list[Intervention]:
        """查询待处理介入单（可按角色过滤）。"""
        stmt = select(Intervention).where(Intervention.status == "pending")
        if assignee:
            stmt = stmt.where(Intervention.assignee_role == assignee)
        return list(self.session.scalars(stmt).all())


def bug_data_of(bug: BugTicket):
    """从 BugTicket 构造仓库复检所需的 DTO（repo_check 统一切分约定）。"""
    from autobugfixer.adapters.platform import BugTicketData

    return BugTicketData(platform=bug.platform, platform_bug_id=bug.platform_bug_id,
                         repo_url=bug.repo_url, repo_branch=bug.repo_branch)


def _validate_adjusted_steps(steps: list) -> list[dict]:
    """人工调整 steps 的回写期校验（与生成期 PlanOutput 同强度，Spec 03 §10）。

    - 每步过 DSLStep 词表/必填参数校验；
    - 至少 3 步且至少 1 条 assert_* 断言（空/无断言方案 = 免检通过，拒绝）。
    违规抛 ValueError（API 层映射 409），介入单保持 pending 可重新提交。
    """
    from autobugfixer.common.dsl import DSLStep
    from autobugfixer.features.planning.schemas import ASSERT_ACTIONS

    if not isinstance(steps, list) or not steps:
        raise ValueError("人工调整的 steps 不能为空")
    try:
        validated = [DSLStep.model_validate(step) for step in steps]
    except Exception as exc:
        raise ValueError(f"人工调整的 steps 含非法步骤: {exc}") from exc
    if len(validated) < 3:
        raise ValueError(f"人工调整的 steps 至少 3 步（与生成期一致），当前 {len(validated)} 步")
    if not any(s.action in ASSERT_ACTIONS for s in validated):
        raise ValueError("人工调整的 steps 至少含 1 条断言动作（assert_*）")
    return [s.model_dump() for s in validated]
