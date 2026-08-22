"""流水线编排器：按状态路由到 Stage，处理四类结果，写状态历史与审计。"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session, sessionmaker

from autobugfixer.platform import BugPlatformAdapter
from autobugfixer.env import EnvExecutor
from autobugfixer.intervention.notifier import LogNotifier, Notifier
from autobugfixer.core.config import Settings, get_settings
from autobugfixer.core.models import BugTicket, Task, TaskStateHistory
from autobugfixer.core.audit import AuditService
from autobugfixer.env.lock import EnvLockService
from autobugfixer.intervention.service import InterventionService
from autobugfixer.core.llm import LLMGateway
from autobugfixer.platform.writeback import writeback_platform_status
from autobugfixer.core.stage import Stage, StageResult, TaskContext
from autobugfixer.core.state import BLOCKING_STATES, TERMINAL_STATES, TaskState, assert_transition
from autobugfixer.completeness import CompletenessStage
from autobugfixer.deploying import DeployingStage
from autobugfixer.fixing import FixingStage
from autobugfixer.learning import LearningStage
from autobugfixer.planning import PlanningStage
from autobugfixer.scoring import ScoringStage
from autobugfixer.verifying import VerifyingStage

logger = logging.getLogger(__name__)

# 状态 -> Stage 路由表（BLOCKING/终态无 Stage，等待外部事件唤醒）
STATE_TO_STAGE: dict[TaskState, str] = {
    TaskState.DISCOVERED: "completeness",  # DISCOVERED 直接进入完整性分析
    TaskState.ANALYZING: "completeness",
    TaskState.PLANNING: "planning",
    TaskState.SCORED: "scoring",
    TaskState.FIXING: "fixing",
    TaskState.DEPLOYING: "deploying",
    TaskState.VERIFYING: "verifying",
    TaskState.LEARNING: "learning",
}


class Orchestrator:
    """状态机编排器。

    - run_task: 执行当前状态对应的一个 Stage（单步，供 worker 调用）；
    - run_until_blocked: 连续推进直到进入阻塞态/终态（供端到端与 CLI 使用）；
    - reclaim_stale_env_locks: 超时回收接口（租约过期释放，任务可重跑）。
    """

    def __init__(
        self,
        session_factory: sessionmaker[Session],
        llm: LLMGateway,
        platform: BugPlatformAdapter,
        executor: EnvExecutor,
        notifier: Notifier | None = None,
        settings: Settings | None = None,
        stages: dict[str, Stage] | None = None,
        codex=None,
        perception=None,
    ) -> None:
        self.session_factory = session_factory
        self.settings = settings or get_settings()
        self.llm = llm
        self.platform = platform
        self.executor = executor
        self.notifier = notifier or LogNotifier()
        # codex 修复通道（None 时按配置构建 CodexCLI；测试注入 ScriptedCodexCLI 桩）
        # 与三维感知服务（可选）
        self.codex = codex
        self.perception = perception
        # Stage 插件注册表：新增阶段在此挂载即可（FR-SYS-01）
        self.stages: dict[str, Stage] = stages or {
            "completeness": CompletenessStage(),
            "planning": PlanningStage(),
            "scoring": ScoringStage(),
            "fixing": FixingStage(),
            "deploying": DeployingStage(),
            "verifying": VerifyingStage(),
            "learning": LearningStage(),
        }

    # ---------- 内部 ----------

    def _build_context(self, session: Session, task: Task) -> TaskContext:
        """为单个任务构建执行上下文：装配 BugTicket 与全部服务句柄。"""
        bug = session.get(BugTicket, task.bug_ticket_id)
        assert bug is not None, f"task {task.id} 缺少关联 BugTicket"

        def _writeback(to_state: str) -> None:
            writeback_platform_status(
                platform=self.platform, bug=bug, to_state=to_state,
                settings=self.settings, audit=AuditService(session),
                notifier=self.notifier, task_id=task.id)

        return TaskContext(
            task=task,
            bug=bug,
            session=session,
            settings=self.settings,
            llm=self.llm,
            platform=self.platform,
            executor=self.executor,
            notifier=self.notifier,
            audit=AuditService(session),
            interventions=InterventionService(session, self.notifier, writeback=_writeback),
            env_locks=EnvLockService(session, lease_seconds=self.settings.env_lock_lease_seconds),
            codex=self.codex,
            perception=self.perception,
        )

    def _transition(self, ctx: TaskContext, to_state: TaskState, stage: str, message: str = "") -> None:
        """执行状态迁移：断言合法性、写状态历史与审计、触发平台状态回写。"""
        task = ctx.task
        from_state = TaskState(task.state)
        assert_transition(from_state, to_state)
        task.state = to_state.value
        task.current_stage = stage
        if to_state == TaskState.CLOSED:
            task.closed_at = datetime.now(timezone.utc)
        ctx.session.add(
            TaskStateHistory(
                task_id=task.id, from_state=from_state.value, to_state=to_state.value,
                stage=stage, message=message,
            )
        )
        ctx.audit.log(
            action="state_transition", target=f"task:{task.id}",
            detail={"from": from_state.value, "to": to_state.value, "stage": stage, "message": message},
            task_id=task.id,
        )
        # 平台状态回写（11.7 status_map）：失败重试一次并告警，不阻塞主流程
        writeback_platform_status(
            platform=self.platform, bug=ctx.bug, to_state=to_state.value,
            settings=self.settings, audit=ctx.audit, notifier=self.notifier,
            task_id=task.id)
        logger.info("task=%s %s -> %s (%s)", task.id, from_state, to_state, message)

    def _handle_result(self, ctx: TaskContext, stage: Stage, result: StageResult) -> StageResult:
        """按四类结果（成功/介入/重试/失败）处理状态迁移与介入单创建。"""
        task = ctx.task
        if result.status == "success":
            assert result.next_state is not None, "success 必须给出 next_state"
            self._transition(ctx, result.next_state, stage.name, result.message)
        elif result.status == "need_intervention":
            assert result.intervention is not None
            ctx.interventions.create(task.id, result.intervention)
            self._transition(ctx, result.intervention.wait_state, stage.name, result.message or result.intervention.title)
        elif result.status == "retry":
            # 重试环：VERIFYING 未通过回 FIXING；retry_count 已在 Stage 内判定上限
            task.retry_count += 1
            assert result.next_state is not None
            self._transition(ctx, result.next_state, stage.name, result.message or f"第 {task.retry_count} 次重试")
        elif result.status == "failed":
            self._transition(ctx, result.next_state or TaskState.FAILED, stage.name, result.message)
        return result

    # ---------- 对外 ----------

    def run_task(self, task_id: int,
                 hold_next_states: set[TaskState] | None = None) -> StageResult | None:
        """执行当前状态对应的一个 Stage。阻塞态/终态返回 None。

        hold_next_states：当 Stage 成功且目标状态在该集合内时，不做迁移，
        只写审计留痕（用于预处理模式：评分准入后停在 SCORED，不自动进入修复）。
        """
        with self.session_factory() as session:
            task = session.get(Task, task_id)
            if task is None:
                raise KeyError(f"任务不存在: {task_id}")
            state = TaskState(task.state)
            if state in BLOCKING_STATES or state in TERMINAL_STATES:
                return None
            stage_name = STATE_TO_STAGE.get(state)
            if stage_name is None:
                return None  # 无 Stage 路由的状态（如 DISCOVERED 由接入服务直接推进）
            stage = self.stages[stage_name]
            ctx = self._build_context(session, task)
            try:
                result = stage.run(ctx)
            except Exception as exc:  # Stage 未捕获的异常 -> FAILED，可从断点续跑
                logger.exception("task=%s stage=%s 异常", task_id, stage_name)
                ctx.audit.log(action="stage_exception", target=f"task:{task_id}",
                              detail={"stage": stage_name, "error": str(exc)}, task_id=task_id)
                # 异常路径兜底释放环境锁（Stage 未能释放时），避免环境被长期占用（11.1）
                if task.environment_id is not None:
                    try:
                        released = ctx.env_locks.release(task.environment_id, task.id)
                    except Exception:
                        logger.exception("异常路径释放环境锁失败（将由租约回收兜底）")
                    else:
                        if released:
                            ctx.audit.log(
                                action="env_lock_release_on_error",
                                target=f"env:{task.environment_id}",
                                detail={"stage": stage_name, "error": str(exc)},
                                task_id=task_id)
                self._transition(ctx, TaskState.FAILED, stage_name, f"stage 异常: {exc}")
                session.commit()
                return StageResult(status="failed", next_state=TaskState.FAILED, message=str(exc))
            if (hold_next_states and result.status == "success"
                    and result.next_state in hold_next_states):
                ctx.audit.log(action="admission_hold", target=f"task:{task_id}",
                              detail={"state": state.value, "held_next": result.next_state.value,
                                      "message": result.message}, task_id=task_id)
                session.commit()
                return result
            self._handle_result(ctx, stage, result)
            session.commit()
            return result

    def run_until_blocked(self, task_id: int, max_steps: int = 20) -> TaskState:
        """连续推进直到阻塞态/终态，返回最终状态。"""
        for _ in range(max_steps):
            # 阻塞态/终态时 run_task 返回 None，循环自然结束
            if self.run_task(task_id) is None:
                break
        return self._state_of(task_id)

    # 预处理阶段对应的状态（评分在 SCORED 态执行）
    PREPROCESS_STATES = (TaskState.ANALYZING, TaskState.PLANNING, TaskState.SCORED)

    def run_preprocessing(self, task_id: int, max_steps: int = 10) -> TaskState:
        """只跑预处理三阶段（completeness -> planning -> scoring），不自动进入修复。

        评分准入的任务停在 SCORED（入队待调度）；其余停在 MANUAL/WAIT_INFO/WAIT_PLAN。
        """
        for _ in range(max_steps):
            if self._state_of(task_id) not in self.PREPROCESS_STATES:
                break
            if self.run_task(task_id, hold_next_states={TaskState.FIXING}) is None:
                break
        return self._state_of(task_id)

    def _state_of(self, task_id: int) -> TaskState:
        """查询任务当前状态（独立会话，不依赖 run_task 的会话）。"""
        with self.session_factory() as session:
            task = session.get(Task, task_id)
            if task is None:
                raise KeyError(f"任务不存在: {task_id}")
            return TaskState(task.state)

    def reclaim_stale_env_locks(self) -> list[int]:
        """超时回收：释放租约过期的环境锁，返回被释放的 env_id 列表。

        worker 崩溃后持锁任务的租约到期，由调度器调用本接口回收，
        部署/验证 Stage 幂等可重入，任务重新跑即可（11.1 防死锁）。
        """
        with self.session_factory() as session:
            service = EnvLockService(session, lease_seconds=self.settings.env_lock_lease_seconds)
            released = service.release_expired()
            session.commit()
            return released
