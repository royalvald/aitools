"""人工介入回写后任务续跑测试（FR-PRE-02 + 4.5）：信息补充场景。"""

from autobugfixer.adapters.platform import BugTicketData, MockBugPlatform
from autobugfixer.common.core.models import BugTicket, Intervention, Task
from autobugfixer.common.core.state import TaskState
from autobugfixer.features.ingest.ingestion import ingest_bug
from autobugfixer.features.intervention.service import InterventionService
from sqlalchemy import select


def _ingest_incomplete_bug(session_factory, platform, settings, repo) -> int:
    data = BugTicketData(
        platform_bug_id="BUG-T002",
        title="页面白屏",
        description="用户反馈打开首页白屏。",  # 缺复现步骤/期望/实际/环境
        repo_url=str(repo),  # 仓库可用：本用例聚焦信息补充介入
        affected_modules=["web"],
    )
    platform._bugs[data.platform_bug_id] = data
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        return task.id


def test_intervention_resolve_resumes_task(make_orchestrator, session_factory,
                                           platform, settings, environment, repo):
    task_id = _ingest_incomplete_bug(session_factory, platform, settings, repo)
    orchestrator = make_orchestrator()

    # 1) 完整性分析判定信息不足 -> WAIT_INFO 阻塞 + 介入单创建
    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.WAIT_INFO
    with session_factory() as s:
        intervention = s.scalar(select(Intervention).where(Intervention.task_id == task_id))
        assert intervention is not None
        assert intervention.type == "info_supplement"
        assert intervention.status == "pending"
        assert "repro_steps" in intervention.context["missing_fields"]
        intervention_id = intervention.id

    # 2) 人工补充信息回写 -> 任务自动续跑直至闭环
    with session_factory() as s:
        service = InterventionService(s)
        service.resolve(intervention_id, {"fields": {
            "repro_steps": "1. 打开首页 2. 观察",
            "expected": "页面正常渲染",
            "actual": "白屏",
            "env_version": "v1.0.0",
        }}, actor="tester-01")
        s.commit()
    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.CLOSED

    with session_factory() as s:
        task = s.get(Task, task_id)
        assert task.info_rounds == 1
        bug = s.get(BugTicket, task.bug_ticket_id)
        assert bug.repro_steps.startswith("1. 打开首页")
        intervention = s.get(Intervention, intervention_id)
        assert intervention.status == "resolved"
        assert intervention.result["fields"]["env_version"] == "v1.0.0"


def test_info_rounds_exhausted_to_manual(make_orchestrator, session_factory,
                                         platform, settings, environment, repo):
    """防死循环：补充往返超上限仍未完整 -> 直接转 MANUAL（4.1.2）。"""
    settings.max_info_rounds = 1
    task_id = _ingest_incomplete_bug(session_factory, platform, settings, repo)
    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.WAIT_INFO

    with session_factory() as s:
        intervention = s.scalar(select(Intervention).where(Intervention.task_id == task_id))
        # 只补一个字段，仍不完整
        InterventionService(s).resolve(intervention.id, {"fields": {"env_version": "v1"}})
        s.commit()

    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.MANUAL
