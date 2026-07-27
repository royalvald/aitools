"""评分准入测试（FR-PRE-04）：低于阈值入队 / 高于阈值转人工；权重可配。"""

from autobugfixer.pipeline.schemas import ScoreOutput
from autobugfixer.pipeline.state import TaskState


def _score_responses(fix: float, verify: float, change: float) -> list:
    """按调用顺序编排 fake 应答：完整性 -> 方案 -> 评分。"""
    return [
        {"complete": True, "missing": [], "suggestions": []},
        {"env_requirements": "本地仿真环境",
         "steps": [{"action": "call_api", "params": {"method": "GET", "path": "/health"}},
                   {"action": "assert_response", "params": {"json_path": "status", "expect": "ok"}}],
         "expected_results": ["ok"], "function_points": ["健康检查"], "regression_scope": "接口"},
        {"fix_difficulty": fix, "verify_difficulty": verify, "change_scale": change,
         "rationale": "测试用评分"},
    ]


def test_low_score_admitted(make_orchestrator, task_id, session_factory):
    """综合分 20*0.4+15*0.3+10*0.3=15.5 < 60 -> 进入自动修复（最终 CLOSED）。"""
    orchestrator = make_orchestrator(_score_responses(20, 15, 10))
    final = orchestrator.run_until_blocked(task_id)
    with session_factory() as s:
        from autobugfixer.models import Task
        task = s.get(Task, task_id)
        assert task.priority_score == 15.5
        assert task.score_detail["rationale"] == "测试用评分"
        assert task.score_detail["weights"]["version"] == "v1"
    assert final == TaskState.CLOSED


def test_high_score_to_manual(make_orchestrator, task_id, session_factory):
    """综合分 90 >= 60 -> 转 MANUAL 并附评分解释。"""
    orchestrator = make_orchestrator(_score_responses(90, 90, 90))
    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.MANUAL
    with session_factory() as s:
        from autobugfixer.models import Task
        task = s.get(Task, task_id)
        assert task.priority_score == 90.0
        assert task.score_detail["threshold"] == 60.0


def test_weights_configurable(make_orchestrator, task_id, session_factory, settings):
    """权重可配置：调整权重改变综合分。"""
    settings.score_weight_fix = 1.0
    settings.score_weight_verify = 0.0
    settings.score_weight_change = 0.0
    orchestrator = make_orchestrator(_score_responses(70, 0, 0))  # 70*1.0=70 >= 60
    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.MANUAL
