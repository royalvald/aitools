"""流水线编排器：按状态路由到 Stage，处理四类结果，写状态历史与审计。"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, update
from sqlalchemy.orm import Session, sessionmaker

from autobugfixer.adapters.platform import BugPlatformAdapter
from autobugfixer.adapters.env import EnvExecutor
from autobugfixer.features.intervention.notifier import LogNotifier, Notifier
from autobugfixer.common.core.config import Settings, get_settings
from autobugfixer.common.core.models import BugTicket, Task
from autobugfixer.common.core.audit import AuditService
from autobugfixer.adapters.env.lock import EnvLockService
from autobugfixer.features.intervention.service import InterventionService
from autobugfixer.common.core.llm import LLMGateway
from autobugfixer.adapters.platform.writeback import writeback_platform_status
from autobugfixer.common.core.stage import Stage, StageResult, TaskContext
from autobugfixer.common.core.state import BLOCKING_STATES, TERMINAL_STATES, TaskState
from autobugfixer.common.core.transitions import transition_task
from autobugfixer.features.completeness import CompletenessStage
from autobugfixer.features.deploying import DeployingStage
from autobugfixer.features.fixing import FixingStage
from autobugfixer.features.learning import LearningStage
from autobugfixer.features.planning import PlanningStage
from autobugfixer.features.scoring import ScoringStage
from autobugfixer.features.verifying import VerifyingStage

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


class _ClaimHeartbeat:
    """Stage 执行期间的后台租约续期线程（P0-4：长任务防双驱）。

    单个 Stage 步骤（如 codex 修复）可能超过认领租约时长；执行期间按
    租约 1/3 周期续约，租约被他人接管（说明本执行者已过期被抢）即停止。
    daemon 线程 + stop 事件，进程崩溃不阻塞退出。
    """

    def __init__(self, orchestrator: "Orchestrator", task_id: int,
                 lease: datetime, *, interval: float | None = None) -> None:
        self._orchestrator = orchestrator
        self._task_id = task_id
        self._lease = lease
        self._stop = threading.Event()
        lease_seconds = orchestrator.settings.task_claim_lease_seconds
        self._interval = (interval if interval is not None
                          else max(min(lease_seconds / 3, 60.0), 5.0))
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name=f"claim-heartbeat-{task_id}")

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                new_lease = self._orchestrator._renew_claim(self._task_id, self._lease)
            except Exception:
                # SQLite 单写者模型下，Stage 事务持有写锁期间续约 UPDATE 可能
                # 短暂拿不到锁（database is locked）：下个周期继续重试，不放弃
                logger.warning("task=%s 认领租约续期暂失败（下周期重试）", self._task_id)
                continue
            if new_lease is None:
                logger.warning("task=%s 认领租约已被他人接管，停止续约", self._task_id)
                return
            self._lease = new_lease

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()


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
        # 修复驱动（None 时修复阶段按 fix_driver 配置回退构建；测试可注入桩）
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
            interventions=InterventionService(
                session, self.notifier, writeback=_writeback,
                sla_hours=self.settings.intervention_sla_hours),
            env_locks=EnvLockService(session, lease_seconds=self.settings.env_lock_lease_seconds),
            codex=self.codex,
            perception=self.perception,
        )

    def _transition(self, ctx: TaskContext, to_state: TaskState, stage: str, message: str = "") -> None:
        """执行状态迁移（统一走 core.transitions.transition_task，保证留痕完整）。"""
        from_state = TaskState(ctx.task.state)
        transition_task(
            ctx.session, ctx.task, to_state, stage=stage, message=message,
            audit=ctx.audit,
            writeback=lambda to: writeback_platform_status(
                platform=self.platform, bug=ctx.bug, to_state=to,
                settings=self.settings, audit=ctx.audit, notifier=self.notifier,
                task_id=ctx.task.id),
        )
        logger.info("task=%s %s -> %s (%s)", ctx.task.id, from_state, to_state, message)

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

    # ---------- 任务认领（并发互斥，11.1 防双驱） ----------

    def _try_claim(self, task_id: int) -> datetime | None:
        """原子认领任务：claimed_until 为空或已过期方可写入新租约。

        多执行者（调度器/API/webhook/介入回写）并发驱动同一任务时，
        后到者在此被挡下，避免两个修复进程写同一工作区。
        返回租约截止时间（naive UTC，心跳续约的比对基准）；认领失败返回 None。
        """
        now = datetime.now(timezone.utc).replace(tzinfo=None)  # 统一 naive UTC 存储
        lease = (datetime.now(timezone.utc)
                 + timedelta(seconds=self.settings.task_claim_lease_seconds)
                 ).replace(tzinfo=None)
        with self.session_factory() as s:
            rows = s.execute(
                update(Task).where(
                    Task.id == task_id,
                    or_(Task.claimed_until.is_(None), Task.claimed_until < now),
                ).values(claimed_until=lease)
            ).rowcount
            s.commit()
            return lease if rows else None

    def _renew_claim(self, task_id: int, expected: datetime) -> datetime | None:
        """心跳续约：仅当 claimed_until 仍等于本执行者写入值时延长（被他人接管即停）。

        返回新租约截止时间；比对失败（租约被抢/已释放）返回 None。
        """
        new_lease = (datetime.now(timezone.utc)
                     + timedelta(seconds=self.settings.task_claim_lease_seconds)
                     ).replace(tzinfo=None)
        with self.session_factory() as s:
            rows = s.execute(
                update(Task).where(
                    Task.id == task_id, Task.claimed_until == expected,
                ).values(claimed_until=new_lease)
            ).rowcount
            s.commit()
            return new_lease if rows else None

    def _release_claim(self, task_id: int) -> None:
        """释放认领（幂等；租约到期后调度器回收也会兜底）。"""
        with self.session_factory() as s:
            s.execute(update(Task).where(Task.id == task_id).values(claimed_until=None))
            s.commit()

    # ---------- 对外 ----------

    def run_task(self, task_id: int,
                 hold_next_states: set[TaskState] | None = None) -> StageResult | None:
        """执行当前状态对应的一个 Stage。阻塞态/终态返回 None。

        hold_next_states：当 Stage 成功且目标状态在该集合内时，不做迁移，
        只写审计留痕（用于预处理模式：评分准入后停在 SCORED，不自动进入修复）。

        并发防护：执行前原子认领（claimed_until 租约），被其他执行者持有时
        返回 None（视同阻塞），绝不并行跑同一任务。Stage 执行期间后台线程
        按租约 1/3 周期心跳续约（P0-4：codex 等长任务单步可超过租约时长，
        无续期会被另一执行者抢注并行写同一工作区）。
        """
        lease = self._try_claim(task_id)
        if lease is None:
            self._state_of(task_id)  # 任务不存在时保持 KeyError 语义
            logger.info("task=%s 已被其他执行者持有（claim），本步跳过", task_id)
            return None
        heartbeat = _ClaimHeartbeat(self, task_id, lease)
        heartbeat.start()
        try:
            return self._run_task_locked(task_id, hold_next_states)
        finally:
            heartbeat.stop()
            self._release_claim(task_id)

    def _run_task_locked(self, task_id: int,
                         hold_next_states: set[TaskState] | None = None) -> StageResult | None:
        """run_task 的实际执行体（调用方已持有任务租约）。"""
        with self.session_factory() as session:
            task = session.get(Task, task_id)
            if task is None:
                raise KeyError(f"任务不存在: {task_id}")
            state = TaskState(task.state)
            if state in BLOCKING_STATES or state in TERMINAL_STATES:
                return None
            stage_name = STATE_TO_STAGE.get(state)
            if stage_name is None:
                return None  # 防御性兜底：非阻塞非终态均已路由，防未来新增状态漏配
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

    # 预处理循环推进的状态（评分在 SCORED 态执行，见 run_preprocessing 收尾步）
    PREPROCESS_STATES = (TaskState.ANALYZING, TaskState.PLANNING)

    def run_preprocessing(self, task_id: int, max_steps: int = 10) -> TaskState:
        """只跑预处理三阶段（completeness -> planning -> scoring），不自动进入修复。

        评分准入的任务停在 SCORED（入队待调度）；其余停在 MANUAL/WAIT_INFO/WAIT_PLAN。
        评分恰好执行一次：循环只推进 ANALYZING/PLANNING，SCORED 态在收尾步
        按"未评分（priority_score 为空）"判定后补一次——修复了旧实现把 SCORED
        纳入循环导致的重复评分（每次导入重复消耗 LLM 调用与审计写入）。
        """
        for _ in range(max_steps):
            if self._state_of(task_id) not in self.PREPROCESS_STATES:
                break
            if self.run_task(task_id, hold_next_states={TaskState.FIXING}) is None:
                break
        if self._state_of(task_id) == TaskState.SCORED:
            with self.session_factory() as s:
                unscored = s.get(Task, task_id).priority_score is None
            if unscored:  # 新入队或方案重生成（旧评分已作废）尚未评分
                self.run_task(task_id, hold_next_states={TaskState.FIXING})
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
