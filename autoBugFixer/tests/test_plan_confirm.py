"""高风险方案人工确认链路测试（Spec 03 §7 A3-A6）。

覆盖：高风险阻塞 WAIT_PLAN（A3）、批准回写进 SCORED（A4）、
批准+调整回写 version+1 并按新版本执行（A5）、拒绝回写转 MANUAL（A6，
B6-3 已知缺陷修复后的回归）。
"""

from sqlalchemy import select

from autobugfixer.platform import BugTicketData
from autobugfixer.core.models import Intervention, Task, VerificationPlan, VerifyRecord
from autobugfixer.core.state import TaskState
from autobugfixer.ingest.ingestion import ingest_bug
from autobugfixer.intervention.service import InterventionService


def _high_risk_bug(repo) -> BugTicketData:
    """字段齐全且命中 core-payment 高风险模块的 Bug。"""
    return BugTicketData(
        platform_bug_id="BUG-PC01",
        title="支付回调偶发重复入账",
        description="核心交易链路：支付回调重复入账。",
        repro_steps="1. 构造超时回调\n2. 重放同一回调",
        expected="同一笔回调只入账一次",
        actual="出现两条入账记录",
        env_version="v2.0.1",
        repo_url=str(repo),
        affected_modules=["core-payment"],  # 命中高风险清单
    )


def _ingest_high_risk(session_factory, settings, repo) -> int:
    with session_factory() as s:
        task, _ = ingest_bug(s, _high_risk_bug(repo), max_retry=settings.max_retry)
        s.commit()
        return task.id


def _pending_plan_intervention(session_factory, task_id) -> Intervention:
    with session_factory() as s:
        return s.scalar(select(Intervention).where(
            Intervention.task_id == task_id,
            Intervention.type == "plan_confirm"))


def test_high_risk_plan_blocks_at_wait_plan(make_orchestrator, session_factory,
                                            settings, repo, environment):
    """A3：命中高风险模块 -> plan_confirm 介入单 + 任务停 WAIT_PLAN。"""
    task_id = _ingest_high_risk(session_factory, settings, repo)
    final = make_orchestrator().run_until_blocked(task_id)
    assert final == TaskState.WAIT_PLAN

    intervention = _pending_plan_intervention(session_factory, task_id)
    assert intervention is not None
    assert intervention.status == "pending"
    assert intervention.assignee_role == "tech_lead"
    assert intervention.context["hit_risk_modules"] == ["core-payment"]
    assert intervention.context["steps"]  # 完整 DSL 步骤供审阅

    with session_factory() as s:
        plan = s.scalar(select(VerificationPlan).where(
            VerificationPlan.task_id == task_id))
        assert plan.risk_level == "high"
        assert plan.confirmed_by is None  # 尚未获人工确认


def test_plan_approved_enters_scored(make_orchestrator, session_factory,
                                     settings, repo, environment):
    """A4：回写 approved=true -> confirmed_by/at 落库、任务进 SCORED 并续跑闭环。"""
    task_id = _ingest_high_risk(session_factory, settings, repo)
    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.WAIT_PLAN

    intervention = _pending_plan_intervention(session_factory, task_id)
    with session_factory() as s:
        InterventionService(s).resolve(intervention.id, {"approved": True},
                                       actor="lead-01")
        s.commit()

    with session_factory() as s:
        task = s.get(Task, task_id)
        assert task.state == TaskState.SCORED.value
        plan = s.scalar(select(VerificationPlan).where(
            VerificationPlan.task_id == task_id))
        assert plan.confirmed_by == "lead-01"
        assert plan.confirmed_at is not None

    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED


def test_plan_approved_with_steps_bumps_version(make_orchestrator, session_factory,
                                                settings, repo, environment):
    """A5：approved=true + steps -> steps 覆盖、version+1、验证按新版本执行。"""
    task_id = _ingest_high_risk(session_factory, settings, repo)
    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.WAIT_PLAN

    intervention = _pending_plan_intervention(session_factory, task_id)
    adjusted_steps = [
        {"action": "call_api", "params": {"method": "GET", "path": "/health"},
         "desc": "调用健康检查接口"},
        {"action": "assert_response",
         "params": {"json_path": "status", "expect": "ok"}, "desc": "断言 status 为 ok"},
        {"action": "input", "params": {"selector": "#env", "value": "v2"},
         "desc": "确认环境版本"},
    ]
    with session_factory() as s:
        InterventionService(s).resolve(
            intervention.id, {"approved": True, "steps": adjusted_steps}, actor="lead-02")
        s.commit()

    with session_factory() as s:
        plan = s.scalar(select(VerificationPlan).where(
            VerificationPlan.task_id == task_id).order_by(
            VerificationPlan.version.desc()))
        assert plan.version == 2
        assert [s_["action"] for s_ in plan.steps] == ["call_api", "assert_response", "input"]

    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED
    with session_factory() as s:
        verify = s.scalar(select(VerifyRecord).where(VerifyRecord.task_id == task_id))
        assert verify.plan_version == 2  # 验证执行的是人工调整后的版本


def test_plan_rejected_goes_manual(make_orchestrator, session_factory,
                                   settings, repo, environment):
    """A6：approved=false -> 任务转 MANUAL（B6-3 缺陷修复回归）。"""
    task_id = _ingest_high_risk(session_factory, settings, repo)
    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.WAIT_PLAN

    intervention = _pending_plan_intervention(session_factory, task_id)
    with session_factory() as s:
        InterventionService(s).resolve(intervention.id, {"approved": False})
        s.commit()

    with session_factory() as s:
        task = s.get(Task, task_id)
        assert task.state == TaskState.MANUAL.value
        intervention = s.get(Intervention, intervention.id)
        assert intervention.status == "resolved"  # 回写成功结案，不再卡死
