"""任务接入回流测试（FR-PRE-02）：平台侧数据更新自动刷新并唤醒 WAIT_INFO 任务。"""

from autobugfixer.adapters.bug_platform import BugTicketData
from autobugfixer.models import BugTicket, Intervention, Task, TaskStateHistory
from autobugfixer.pipeline.state import TaskState
from autobugfixer.services.ingestion import ingest_bug
from sqlalchemy import select


def _complete_data(bug_id: str = "BUG-RE1") -> BugTicketData:
    return BugTicketData(
        platform_bug_id=bug_id, title="标题", description="描述",
        repro_steps="1. 复现", expected="期望", actual="实际", env_version="v1",
        affected_modules=["web"],
    )


def _ingest(session_factory, data, settings) -> int:
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        return task.id


def test_ingest_refreshes_existing_bug(session_factory, settings):
    """已存在的 Bug 用最新平台数据刷新字段，且不打断非 WAIT_INFO 任务。"""
    task_id = _ingest(session_factory, _complete_data(), settings)
    with session_factory() as s:
        updated = _complete_data()
        updated.title = "新标题"
        updated.description = "新描述"
        updated.repro_steps = "2. 新复现"
        task, created = ingest_bug(s, updated, max_retry=3)
        s.commit()
        assert created is False
        assert task.id == task_id
        bug = s.get(BugTicket, task.bug_ticket_id)
        assert bug.title == "新标题"
        assert bug.repro_steps == "2. 新复现"
        assert s.get(Task, task_id).state == TaskState.ANALYZING.value  # 非 WAIT_INFO 不唤醒


def test_ingest_wakes_wait_info_task(make_orchestrator, session_factory,
                                     settings, environment):
    """平台侧补全信息 -> 轮询接入刷新字段并唤醒 WAIT_INFO 任务，直至闭环。"""
    incomplete = BugTicketData(platform_bug_id="BUG-RE2", title="页面白屏",
                               description="白屏", affected_modules=["web"])
    task_id = _ingest(session_factory, incomplete, settings)
    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.WAIT_INFO

    # 平台侧补全信息后再次轮询接入
    complete = BugTicketData(
        platform_bug_id="BUG-RE2", title="页面白屏", description="白屏",
        repro_steps="1. 打开首页", expected="页面正常渲染", actual="白屏",
        env_version="v1.0.0", affected_modules=["web"])
    with session_factory() as s:
        task, created = ingest_bug(s, complete, max_retry=settings.max_retry)
        s.commit()
        assert created is False
        assert task.state == TaskState.ANALYZING.value  # 已唤醒
        histories = [h.message for h in s.scalars(select(TaskStateHistory).where(
            TaskStateHistory.task_id == task_id)).all()]
        assert any("平台侧数据更新" in m for m in histories)

    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.CLOSED
    with session_factory() as s:
        bug = s.get(BugTicket, task.bug_ticket_id)
        assert bug.repro_steps == "1. 打开首页"
        # 旧介入单自动关闭，不残留待办
        pending = s.scalars(select(Intervention).where(
            Intervention.status == "pending")).all()
        assert pending == []
        assert s.get(Task, task_id).info_rounds == 1


def test_ingest_does_not_wake_wait_info_without_change(make_orchestrator,
                                                       session_factory, settings):
    """数据无变化时不得反复唤醒 WAIT_INFO（防轮询导致补充往返无限循环）。"""
    incomplete = BugTicketData(platform_bug_id="BUG-RE3", title="白屏",
                               description="白屏", affected_modules=["web"])
    task_id = _ingest(session_factory, incomplete, settings)
    assert make_orchestrator().run_until_blocked(task_id) == TaskState.WAIT_INFO

    with session_factory() as s:
        task, created = ingest_bug(s, incomplete, max_retry=settings.max_retry)
        s.commit()
        assert created is False
        assert task.state == TaskState.WAIT_INFO.value  # 未变化不唤醒


def test_ingest_repairs_orphan_bugticket(session_factory):
    """脏数据兜底：存在 BugTicket 但缺任务时补建任务，不返回 None。"""
    with session_factory() as s:
        s.add(BugTicket(platform="mock", platform_bug_id="BUG-RE4", title="孤儿"))
        s.commit()
    with session_factory() as s:
        task, created = ingest_bug(s, BugTicketData(
            platform="mock", platform_bug_id="BUG-RE4", title="孤儿"))
        s.commit()
        assert created is False
        assert task is not None
        assert task.state == TaskState.ANALYZING.value
        assert s.get(Task, task.id) is not None
