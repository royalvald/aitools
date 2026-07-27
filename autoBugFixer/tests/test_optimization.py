"""自我优化评审测试（FR-SYS-02 简化版）：建议 -> 评审批准 -> 版本生效 -> 回退。"""

from sqlalchemy import select

from autobugfixer.models import Intervention, StrategyVersion
from autobugfixer.pipeline.state import TaskState
from autobugfixer.services.intervention import InterventionService
from autobugfixer.services.optimization import (
    create_optimization_intervention,
    rollback_strategy,
)


def _seed_scored_tasks(session_factory):
    """造样本：低分通过 + 高分失败（准入过松场景）。"""
    from autobugfixer.models import BugTicket, Task

    with session_factory() as s:
        for i, (state, score) in enumerate(
                [("CLOSED", 20.0), ("CLOSED", 25.0), ("MANUAL", 55.0), ("MANUAL", 58.0)]):
            bug = BugTicket(platform="mock", platform_bug_id=f"OPT-{i}", title=f"b{i}")
            s.add(bug)
            s.flush()
            s.add(Task(bug_ticket_id=bug.id, state=state, priority_score=score))
        s.commit()


def test_optimization_full_flow(make_orchestrator, task_id, session_factory, settings):
    _seed_scored_tasks(session_factory)
    # 1) 生成建议：失败均分(56.5) > 通过均分(22.5) -> 建议收紧阈值 60 -> 54
    with session_factory() as s:
        intervention = create_optimization_intervention(
            s, None, {"fix": 0.4, "verify": 0.3, "change": 0.3}, 60.0)
        assert intervention.type == "optimization"
        assert intervention.context["suggestion"]["threshold"] == 54.0
        s.commit()
        intervention_id = intervention.id

    # 2) 研发批准 -> 策略版本生效
    with session_factory() as s:
        InterventionService(s).resolve(intervention_id, {"approved": True}, actor="lead-01")
        s.commit()
        version = s.scalar(select(StrategyVersion).where(StrategyVersion.active.is_(True)))
        assert version.weights["threshold"] == 54.0
        assert version.source_intervention_id == intervention_id

    # 3) scoring 读取生效版本：默认 fake 评分 15.5 < 54 仍入队
    orchestrator = make_orchestrator()
    assert orchestrator.run_preprocessing(task_id) == TaskState.SCORED
    with session_factory() as s:
        from autobugfixer.models import Task
        assert s.get(Task, task_id).score_detail["weights"]["version"] == "strategy:v1"

    # 4) 收紧到阈值 10 的第二版本生效 -> 同样本转 MANUAL
    with session_factory() as s:
        it = Intervention(task_id=0, type="optimization", title="二版",
                          context={"suggestion": {"weights": {"fix": 0.4},
                                                  "threshold": 10.0, "reason": "收紧"}},
                          status="pending", assignee_role="tech_lead")
        s.add(it)
        s.flush()
        InterventionService(s).resolve(it.id, {"approved": True}, actor="lead-01")
        s.commit()
    # 重新分析同一任务（MANUAL -> ANALYZING 合法迁移）
    with session_factory() as s:
        from autobugfixer.models import Task
        t = s.get(Task, task_id)
        t.state = TaskState.ANALYZING.value
        s.commit()
    assert orchestrator.run_preprocessing(task_id) == TaskState.MANUAL

    # 5) 回退到 v1 -> 恢复入队
    with session_factory() as s:
        rollback_strategy(s, 1, actor="lead-01")
        assert s.scalar(select(StrategyVersion).where(
            StrategyVersion.active.is_(True))).version == 1
        s.commit()
    with session_factory() as s:
        from autobugfixer.models import Task
        t = s.get(Task, task_id)
        t.state = TaskState.ANALYZING.value
        s.commit()
    assert orchestrator.run_preprocessing(task_id) == TaskState.SCORED
