"""常驻调度器测试：单轮逻辑（拉新/出队/锁回收/介入 SLA），不跑死循环。"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from autobugfixer.intervention.notifier import LogNotifier
from autobugfixer.core.models import Intervention, Task, TaskStateHistory
from autobugfixer.core.state import TaskState
from autobugfixer.runtime.scheduler import Scheduler


@pytest.fixture()
def scheduler(make_orchestrator, session_factory, platform, settings):
    return Scheduler(make_orchestrator(), platform, LogNotifier(),
                     session_factory, settings)


def test_round_ingests_and_advances_new_bugs(scheduler, session_factory, environment):
    """轮询接入新 Bug 后自动推进预处理并出队（平台更新回流闭环）。"""
    stats = scheduler.run_round()
    assert stats["ingested"] == 1  # mock 平台中的 BUG-T001
    assert stats["preprocessed"] == [1]
    assert stats["dispatched"] == [1]
    with session_factory() as s:
        assert s.get(Task, 1).state == TaskState.CLOSED.value
    # 第二轮幂等：不再重复接入/推进
    stats2 = scheduler.run_round()
    assert stats2["ingested"] == 0
    assert stats2["preprocessed"] == []
    assert stats2["dispatched"] == []


def test_round_dispatches_scored_tasks(scheduler, make_orchestrator, task_id,
                                       session_factory):
    # 先跑预处理让任务入队（SCORED）
    orchestrator = make_orchestrator()
    assert orchestrator.run_preprocessing(task_id) == TaskState.SCORED

    stats = scheduler.run_round()
    assert stats["dispatched"] == [task_id]
    with session_factory() as s:
        task = s.get(Task, task_id)
        assert task.state == TaskState.CLOSED.value  # 出队后全链路跑通
        stages = [h.stage for h in s.scalars(select(TaskStateHistory).where(
            TaskStateHistory.task_id == task_id)).all()]
        assert "scheduler" in stages  # 出队留痕


def test_intervention_sla_timeout_and_remind(scheduler, session_factory, task_id):
    now = datetime.now(timezone.utc)
    with session_factory() as s:
        s.add_all([
            Intervention(task_id=task_id, type="info_supplement", title="已超时",
                         assignee_role="tester", status="pending",
                         deadline=now - timedelta(hours=1)),
            Intervention(task_id=task_id, type="plan_confirm", title="临期",
                         assignee_role="tech_lead", status="pending",
                         deadline=now + timedelta(hours=1)),
            Intervention(task_id=task_id, type="plan_confirm", title="尚早",
                         assignee_role="tech_lead", status="pending",
                         deadline=now + timedelta(hours=10)),
        ])
        s.commit()
    reminded, timeout = scheduler.scan_intervention_sla()
    assert (reminded, timeout) == (1, 1)
    with session_factory() as s:
        items = {i.title: i.status for i in s.scalars(select(Intervention)).all()}
        assert items == {"已超时": "timeout", "临期": "pending", "尚早": "pending"}


def test_intervention_sla_suspend(scheduler, session_factory, task_id, settings):
    """超时升级策略 suspend：任务挂起为 FAILED。"""
    settings.intervention_escalation = "suspend"
    now = datetime.now(timezone.utc)
    with session_factory() as s:
        task = s.get(Task, task_id)
        task.state = TaskState.FIXING.value  # 执行中状态才允许挂起
        s.add(Intervention(task_id=task_id, type="discussion", title="超时挂起",
                           assignee_role="developer", status="pending",
                           deadline=now - timedelta(hours=2)))
        s.commit()
    scheduler.scan_intervention_sla()
    with session_factory() as s:
        assert s.get(Task, task_id).state == TaskState.FAILED.value


def test_graceful_stop_flag(scheduler):
    scheduler.stop()
    assert scheduler._stop is True
