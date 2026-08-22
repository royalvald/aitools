"""失败分支完整化测试（FR-MEM-02）：LLM 不适用场景 + 讨论介入 + 三类回写流转。"""

import pytest
from sqlalchemy import select

from autobugfixer.common.core.models import InapplicableCase, Intervention, Task
from autobugfixer.common.core.state import TaskState
from autobugfixer.features.intervention.service import InterventionService

# 让验证永远失败的方案（断言一个不可能的值），队列耗尽后走关键字兜底应答
FAILING_PLAN_RESPONSES = [
    {"complete": True, "missing": [], "suggestions": []},
    {"env_requirements": "env",
     "steps": [
         {"action": "input", "params": {"selector": "#env", "value": "v1"},
          "desc": "确认环境版本"},
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
        assert task.closed_at is not None  # Spec 08 §3.5：人工关闭同样写 closed_at
        s.commit()


def test_learning_without_verify_record_goes_failure_branch(
        make_orchestrator, session_factory, settings, task_id):
    """无任何 VerifyRecord 进入 LEARNING（相同 diff 提前终止路径）-> 失败分支不抛错。"""
    orchestrator = make_orchestrator()
    assert orchestrator.run_preprocessing(task_id) == TaskState.SCORED
    with session_factory() as s:
        task = s.get(Task, task_id)
        task.state = TaskState.FIXING.value  # 直接置于 FIXING/LEARNING 构造无验证记录场景
        task.state = TaskState.LEARNING.value
        s.commit()
    final = orchestrator.run_task(task_id)
    assert final.status == "need_intervention"
    with session_factory() as s:
        case = s.scalar(select(InapplicableCase).where(
            InapplicableCase.task_id == task_id))
        assert case is not None and case.reason  # 规则模板兜底（重试 0 次仍...)
        intervention = s.scalar(select(Intervention).where(
            Intervention.task_id == task_id, Intervention.type == "discussion"))
        assert intervention is not None
        assert TaskState(s.get(Task, task_id).state) == TaskState.WAIT_DISCUSS


def test_discussion_manual_fix(failed_task, session_factory):
    with session_factory() as s:
        intervention = s.scalar(select(Intervention).where(
            Intervention.task_id == failed_task))
        task = InterventionService(s).resolve(intervention.id, {"action": "manual_fix"})
        assert TaskState(task.state) == TaskState.MANUAL
        s.commit()
