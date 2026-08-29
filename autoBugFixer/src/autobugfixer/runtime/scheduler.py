"""常驻调度器（设计文档 8：Scheduler 轮询/优先级出队/超时回收）。

单轮逻辑抽成 ``Scheduler.run_round``（可测）；``run_forever`` 循环 + 优雅停止。
每轮执行：
1. 轮询 Bug 平台拉新（标准化入库）；
2. 推进预处理：轮询接入的新任务与平台侧更新唤醒的任务
   （ANALYZING/PLANNING）完成完整性/方案/评分入队；
3. 按 priority_score 升序出队调度 SCORED 任务（先易后难，数量上限可配）；
4. 回收租约过期的环境锁（worker 崩溃防死锁，11.1）；
5. 介入 SLA 扫描：临期提醒 -> 超时标 timeout 并按配置升级/挂起。
"""

from __future__ import annotations

import logging
import signal
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session, sessionmaker

from autobugfixer.adapters.platform import BugPlatformAdapter
from autobugfixer.features.intervention.notifier import NoticeMessage, Notifier
from autobugfixer.common.core.config import Settings, get_settings
from autobugfixer.common.core.models import Intervention, Task
from autobugfixer.runtime.orchestrator import Orchestrator
from autobugfixer.common.core.state import TaskState
from autobugfixer.common.core.audit import AuditService
from autobugfixer.features.ingest.ingestion import ingest_bug

logger = logging.getLogger(__name__)


class Scheduler:
    """常驻调度器：轮询拉新、优先级出队、超时回收、介入 SLA。"""

    def __init__(self, orchestrator: Orchestrator,
                 platform: BugPlatformAdapter,
                 notifier: Notifier,
                 session_factory: sessionmaker[Session],
                 settings: Settings | None = None) -> None:
        self.orchestrator = orchestrator
        self.platform = platform
        self.notifier = notifier
        self.session_factory = session_factory
        self.settings = settings or orchestrator.settings or get_settings()
        self._stop = False

    # ---------- 单轮（可测） ----------

    def run_round(self) -> dict:
        """执行一轮调度，返回本轮统计。"""
        stats = {"ingested": 0, "preprocessed": [], "dispatched": [], "locks_reclaimed": 0,
                 "inflight_recovered": [], "wait_env_woken": [],
                 "sla_reminded": 0, "sla_timeout": 0}
        stats["ingested"] = self.poll_platform()
        stats["preprocessed"] = self.preprocess_pending()
        stats["locks_reclaimed"] = len(self.orchestrator.reclaim_stale_env_locks())
        stats["inflight_recovered"] = self.recover_inflight()
        stats["wait_env_woken"] = self.wake_wait_env()
        stats["dispatched"] = self.dispatch_scored()
        sla = self.scan_intervention_sla()
        stats["sla_reminded"], stats["sla_timeout"] = sla
        return stats

    def poll_platform(self) -> int:
        """拉取平台 Bug 列表，幂等入库，返回新接入数量。"""
        count = 0
        with self.session_factory() as s:
            for data in self.platform.list_bugs():
                _, created = ingest_bug(s, data, max_retry=self.settings.max_retry)
                count += int(created)
            s.commit()
        return count

    def preprocess_pending(self) -> list[int]:
        """推进等待预处理的 ANALYZING/PLANNING 任务至评分入队。

        平台轮询接入的新 Bug 与平台侧数据更新唤醒的任务都落在 ANALYZING，
        本步让它们完成完整性/方案/评分；已评分的 SCORED 不在此处理
        （避免重复评分），由 dispatch_scored 统一按优先级出队。
        附带覆盖"SCORED 但未评分"的残留（如崩在评分前）——run_preprocessing
        收尾步会恰好补一次评分。
        """
        with self.session_factory() as s:
            task_ids = [t.id for t in s.scalars(select(Task).where(
                or_(Task.state.in_([TaskState.ANALYZING.value, TaskState.PLANNING.value]),
                    and_(Task.state == TaskState.SCORED.value,
                         Task.priority_score.is_(None)))
            ).order_by(Task.id)).all()]
        for task_id in task_ids:
            try:
                self.orchestrator.run_preprocessing(task_id)
            except Exception:
                logger.exception("预处理任务 %s 异常", task_id)
        return task_ids

    def recover_inflight(self) -> list[int]:
        """回收孤儿 in-flight 任务（A3：进程崩在执行态后的断点续跑）。

        FIXING/DEPLOYING/VERIFYING/LEARNING 无外部等待语义，任何时候都应可推进；
        任务认领租约（claimed_until）保证不与在跑执行者撞车——在跑任务的
        run_until_blocked 会在认领处直接停下。
        """
        inflight = [TaskState.FIXING.value, TaskState.DEPLOYING.value,
                    TaskState.VERIFYING.value, TaskState.LEARNING.value]
        with self.session_factory() as s:
            task_ids = [t.id for t in s.scalars(select(Task).where(
                Task.state.in_(inflight)).order_by(Task.id)).all()]
        for task_id in task_ids:
            try:
                final = self.orchestrator.run_until_blocked(task_id)
                logger.info("回收 in-flight 任务 %s -> %s", task_id, final)
            except Exception:
                logger.exception("回收 in-flight 任务 %s 异常", task_id)
        return task_ids

    def wake_wait_env(self) -> list[int]:
        """唤醒 WAIT_ENV 任务（A5：锁释放后按优先级唤醒，设计 11.1）。

        仅当目标环境锁实际空闲（无持有人或租约已过期）才唤醒，且每轮每个
        环境只唤醒一个（优先级最高的），避免唤醒后抢锁失败来回翻转。
        """
        from autobugfixer.common.core.models import EnvLock
        from autobugfixer.common.core.transitions import transition_task

        now = datetime.now(timezone.utc)
        woken: list[int] = []
        with self.session_factory() as s:
            waiting = list(s.scalars(select(Task).where(
                Task.state == TaskState.WAIT_ENV.value).order_by(
                Task.priority_score.asc().nulls_last(), Task.id)).all())
            busy_env: set[int] = set()
            for task in waiting:
                env_id = task.environment_id
                if env_id is None or env_id in busy_env:
                    continue
                lock = s.get(EnvLock, env_id)
                if lock is not None and lock.holder_task_id != task.id:
                    expires = lock.expires_at
                    if expires.tzinfo is None:
                        expires = expires.replace(tzinfo=timezone.utc)
                    if expires > now:  # 仍被他人持有且租约未过期
                        busy_env.add(env_id)
                        continue
                transition_task(s, task, TaskState.DEPLOYING, stage="scheduler",
                                message="环境锁空闲，按优先级唤醒等锁任务")
                busy_env.add(env_id)
                woken.append(task.id)
            s.commit()
        for task_id in woken:
            try:
                final = self.orchestrator.run_until_blocked(task_id)
                logger.info("唤醒等锁任务 %s -> %s", task_id, final)
            except Exception:
                logger.exception("唤醒等锁任务 %s 异常", task_id)
        return woken

    def dispatch_scored(self) -> list[int]:
        """按 priority_score 升序（先易后难）出队已评分的 SCORED 任务并推进流水线。

        出队即 SCORED -> FIXING 迁移（统一走 transition_task：校验 + 历史 + 审计）；
        未评分的 SCORED 任务不出队（由 preprocess_pending 补评分）。
        """
        from autobugfixer.common.core.transitions import transition_task

        with self.session_factory() as s:
            tasks = list(s.scalars(select(Task).where(
                Task.state == TaskState.SCORED.value,
                Task.priority_score.is_not(None)).order_by(
                Task.priority_score.asc()).limit(self.settings.scheduler_dispatch_limit)).all())
            task_ids = [t.id for t in tasks]
            for task in tasks:  # 出队迁移 + 留痕
                transition_task(s, task, TaskState.FIXING, stage="scheduler",
                                message="调度器按优先级出队")
            s.commit()
        for task_id in task_ids:
            try:
                final = self.orchestrator.run_until_blocked(task_id)
                logger.info("调度任务 %s -> %s", task_id, final)
            except Exception:
                logger.exception("调度任务 %s 异常", task_id)
        return task_ids

    def scan_intervention_sla(self) -> tuple[int, int]:
        """介入 SLA：临期提醒，超时标 timeout 并按配置升级（remind/suspend）。"""
        now = datetime.now(timezone.utc)
        remind_before = now + timedelta(hours=self.settings.intervention_remind_before_hours)
        reminded = timeout = 0
        with self.session_factory() as s:
            audit = AuditService(s)
            pendings = list(s.scalars(select(Intervention).where(
                Intervention.status == "pending",
                Intervention.deadline.is_not(None))).all())
            for it in pendings:
                deadline = it.deadline
                if deadline.tzinfo is None:
                    deadline = deadline.replace(tzinfo=timezone.utc)
                if deadline <= now:
                    it.status = "timeout"
                    timeout += 1
                    audit.log(action="intervention_timeout",
                              target=f"intervention:{it.id}",
                              detail={"escalation": self.settings.intervention_escalation},
                              task_id=it.task_id or None)
                    if self.settings.intervention_escalation == "suspend" and it.task_id:
                        self._suspend_task(s, it, audit)
                    else:  # remind：提醒上级角色
                        self._notify("manager", f"介入单超时未处理: {it.title}",
                                     f"intervention #{it.id} 已超过 SLA")
                elif deadline <= remind_before:
                    reminded += 1
                    self._notify(it.assignee_role, f"介入单临期提醒: {it.title}",
                                 f"intervention #{it.id} 将于 {deadline:%H:%M} 超时")
            s.commit()
        return reminded, timeout

    # ---------- 内部 ----------

    def _suspend_task(self, s: Session, it: Intervention, audit: AuditService) -> None:
        """超时挂起：任务置 FAILED（可人工重新触发；迁移统一留痕历史+审计）。"""
        from autobugfixer.common.core.transitions import transition_task

        task = s.get(Task, it.task_id)
        if task is None or task.state in (TaskState.CLOSED.value, TaskState.CANCELLED.value):
            return
        try:
            transition_task(s, task, TaskState.FAILED, stage="scheduler",
                            message=f"介入单 #{it.id} SLA 超时挂起",
                            audit=audit)
        except Exception:
            return  # 当前状态不允许直接置 FAILED 时仅留痕
        self._notify("manager", f"任务已挂起: #{task.id}",
                     f"介入单 #{it.id} 超时，任务转入 FAILED 待人工处理")

    def _notify(self, role: str, title: str, content: str) -> None:
        try:
            self.notifier.send(role, NoticeMessage(title=title, content=content))
        except Exception:
            logger.warning("调度器通知发送失败（已忽略）: %s", title)

    # ---------- 常驻循环 ----------

    def stop(self) -> None:
        """请求优雅停止（下一轮 sleep 结束后退出）。"""
        self._stop = True

    def run_forever(self) -> None:
        """常驻循环：按配置间隔跑单轮，捕获 SIGINT/SIGTERM 优雅停止。"""
        def _handler(signum, frame):
            logger.info("收到信号 %s，准备优雅停止", signum)
            self._stop = True

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, _handler)
            except (ValueError, OSError):  # 非主线程/平台不支持时忽略
                pass
        interval = self.settings.scheduler_poll_interval_seconds
        logger.info("调度器启动，轮询间隔 %ss", interval)
        while not self._stop:
            try:
                stats = self.run_round()
                logger.info("调度轮次完成: %s", stats)
            except Exception:
                logger.exception("调度轮次异常")
            # 分段 sleep，保证停止信号及时响应
            for _ in range(max(int(interval), 1)):
                if self._stop:
                    break
                time.sleep(1)
        logger.info("调度器已停止")
