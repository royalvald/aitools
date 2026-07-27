"""失败分支完整化测试（FR-MEM-02）：LLM 不适用场景 + 讨论介入 + 三类回写流转。"""

import pytest
from sqlalchemy import select

from autobugfixer.models import InapplicableCase, Intervention, Task
from autobugfixer.pipeline.state import TaskState
from autobugfixer.services.intervention import InterventionService

# 让验证永远失败的方案（断言一个不可能的值），队列耗尽后走关键字兜底应答
FAILING_PLAN_RESPONSES = [
    {"complete": True, "missing": [], "suggestions": []},
    {"env_requirements": "env",
     "steps": [
         {"action": "call_api", "params": {"method": "GET", "path": "/health"}},
         {"action": "assert_response",
          "params": {"json_path": "status", "expect": "never-match"}},
     ],
     "expected_results": [], "function_points": [], "regression_scope": ""},
]


@pytest.fixture()
def failed_task(make_orchestrator, task_id, session_factory, environment):
    """重试后仍验证失败 -> WAIT_DISCUSS 的任务。"""
    orchestrator = make_orchestrator(list(FAILING_PLAN_RESPONSES))
    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.WAIT_DISCUSS
    return task_id


def test_failure_branch_llm_analysis(failed_task, session_factory):
    with session_factory() as s:
        case = s.scalar(select(InapplicableCase).where(
            InapplicableCase.task_id == failed_task))
        assert case is not None
        assert "fake 模式默认不适用场景" in case.condition_desc  # LLM 兜底应答
        assert case.discussion_topic
        intervention = s.scalar(select(Intervention).where(
            Intervention.task_id == failed_task))
        assert intervention.type == "discussion"
        assert intervention.status == "pending"


def test_discussion_retry_resets_count(failed_task, session_factory):
    with session_factory() as s:
        intervention = s.scalar(select(Intervention).where(
            Intervention.task_id == failed_task))
        task = InterventionService(s).resolve(intervention.id, {"action": "retry"})
        assert task.retry_count == 0  # 人工决定重试：重置计数
        assert TaskState(task.state) == TaskState.FIXING
        s.commit()


def test_discussion_close(failed_task, session_factory):
    with session_factory() as s:
        intervention = s.scalar(select(Intervention).where(
            Intervention.task_id == failed_task))
        task = InterventionService(s).resolve(intervention.id, {"action": "close"})
        assert TaskState(task.state) == TaskState.CLOSED
        s.commit()


def test_discussion_manual_fix(failed_task, session_factory):
    with session_factory() as s:
        intervention = s.scalar(select(Intervention).where(
            Intervention.task_id == failed_task))
        task = InterventionService(s).resolve(intervention.id, {"action": "manual_fix"})
        assert TaskState(task.state) == TaskState.MANUAL
        s.commit()
