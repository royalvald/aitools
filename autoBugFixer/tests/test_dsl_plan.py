"""方案深度硬校验与 DSL 解释器语义测试（Spec 03 §9 / Spec 07 §3）。

覆盖：PlanOutput 四段式校验（>=3 步且含断言）、fix_approach 落库与首轮修复
prompt 注入、check_log absent 否定断言、DSLInterpreter 逐动作语义与单步异常
捕获边界、空步骤空真通过。
"""

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from autobugfixer.core.models import FixRecord, VerificationPlan
from autobugfixer.dsl import DSLInterpreter, StepResult
from autobugfixer.planning.schemas import PlanOutput
from autobugfixer.core.state import TaskState


def _steps(with_assert: bool = True) -> list[dict]:
    steps = [
        {"action": "input", "params": {"selector": "#env", "value": "v1"}},
        {"action": "call_api", "params": {"method": "GET", "path": "/health"}},
    ]
    if with_assert:
        steps.append({"action": "assert_response",
                      "params": {"json_path": "status", "expect": "ok"}})
    else:
        steps.append({"action": "click", "params": {"selector": "#go"}})
    return steps


# ---------- PlanOutput 四段式硬校验（Spec 03 §9.2） ----------

def test_plan_output_rejects_too_few_steps():
    with pytest.raises(ValidationError, match="至少 3 步"):
        PlanOutput(steps=_steps()[:2])


def test_plan_output_rejects_steps_without_assert():
    with pytest.raises(ValidationError, match="断言"):
        PlanOutput(steps=_steps(with_assert=False))


def test_plan_output_accepts_complete_flow_with_fix_approach():
    out = PlanOutput(steps=_steps(), fix_approach={
        "locate_hints": ["堆栈指向 api/health.py"],
        "change_files": ["api/health.py"],
        "strategy": "降级返回 unknown",
    })
    assert out.fix_approach is not None
    assert out.fix_approach.change_files == ["api/health.py"]


# ---------- fix_approach 落库与修复首轮注入（Spec 03 §9.4） ----------

def test_fix_approach_persisted_and_injected_into_first_prompt(
        make_orchestrator, task_id, session_factory, environment):
    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED

    with session_factory() as s:
        plan = s.scalar(select(VerificationPlan).where(
            VerificationPlan.task_id == task_id).order_by(
            VerificationPlan.version.desc()))
        # 落库（Fake 应答自带 fix_approach）
        assert plan.fix_approach.get("change_files") == ["api/health.json"]
        assert "status" in plan.fix_approach.get("strategy", "")
        # 首轮修复 prompt 注入大纲块
        fix = s.scalar(select(FixRecord).where(
            FixRecord.task_id == task_id, FixRecord.attempt == 1))
        assert "修复思路大纲" in fix.prompt_snapshot
        assert "定位线索" in fix.prompt_snapshot


# ---------- DSLInterpreter 语义（Spec 07 §3） ----------

class FakeRuntime:
    """内存文件系统 + 固定行集的 DSL 运行时替身。"""

    def __init__(self, files: dict[str, str] | None = None,
                 rows: list[dict] | None = None) -> None:
        self.files = files or {}
        self.rows = rows or []

    def read_text(self, rel_path: str) -> str | None:
        return self.files.get(rel_path)

    def query_db(self, sql: str) -> list[dict]:
        return self.rows


def _run(runtime: FakeRuntime, steps: list[dict]) -> list[StepResult]:
    return DSLInterpreter(runtime).execute(steps)


def test_open_page_maps_url_to_simulated_file():
    rt = FakeRuntime(files={"pages/order.html": "<html>订单页</html>"})
    results = _run(rt, [{"action": "open_page", "params": {"url": "/order"}}])
    assert results[0].passed and "订单页" in results[0].evidence


def test_call_api_missing_file_fails_step_not_pipeline():
    results = _run(FakeRuntime(), [{"action": "call_api",
                                    "params": {"method": "GET", "path": "/none"}}])
    assert results[0].passed is False
    assert "接口无响应" in results[0].detail


def test_assert_element_substring_semantics():
    rt = FakeRuntime(files={"pages/p.html": "<button id='submit-btn'>提交</button>"})
    results = _run(rt, [
        {"action": "open_page", "params": {"url": "/p"}},
        {"action": "assert_element", "params": {"selector": "submit-btn", "state": "present"}},
        {"action": "assert_element", "params": {"selector": "missing", "state": "absent"}},
        {"action": "assert_element", "params": {"selector": "x", "state": "text:提交"}},
        {"action": "assert_element", "params": {"selector": "x", "state": "bogus"}},
    ])
    assert [r.passed for r in results[1:]] == [True, True, True, False]


def test_assert_response_json_path_and_vacuous_status():
    rt = FakeRuntime(files={"api/health.json": '{"status": "ok"}'})
    results = _run(rt, [
        {"action": "call_api", "params": {"method": "GET", "path": "/health"}},
        {"action": "assert_response",
         "params": {"json_path": "status", "expect": "ok", "status": 200}},
    ])
    # 仿真响应无 http_status 字段时 status 断言取期望值兜底（必过，已知限制）
    assert all(r.passed for r in results)


def test_assert_response_without_prior_call_fails():
    results = _run(FakeRuntime(), [{"action": "assert_response",
                                    "params": {"expect": "ok"}}])
    assert results[0].passed is False and "尚未调用接口" in results[0].detail


def test_query_db_rejects_write_sql_as_failed_step():
    rt = FakeRuntime(rows=[{"n": 1}])
    results = _run(rt, [
        {"action": "query_db", "params": {"sql": "select count(*) as n from t"}},
        {"action": "query_db", "params": {"sql": "update t set a=1"}},
    ])
    assert results[0].passed and results[1].passed is False
    assert "只读 SELECT" in results[1].detail


def test_assert_db_row_count_and_field_forms():
    rt = FakeRuntime(rows=[{"status": "ok"}, {"status": "ok"}])
    results = _run(rt, [
        {"action": "assert_db",
         "params": {"sql": "select status from t", "expect": "row_count>=2"}},
        {"action": "assert_db",
         "params": {"sql": "select status from t", "expect": "status=ok"}},
        {"action": "assert_db",
         "params": {"sql": "select status from t", "expect": "bogus-form"}},
    ])
    assert [r.passed for r in results] == [True, True, False]


def test_check_log_present_and_absent_modes():
    rt = FakeRuntime(files={"logs/app.log": "INFO start\nERROR health boom\nINFO end"})
    results = _run(rt, [
        {"action": "check_log", "params": {"service": "app", "pattern": "INFO"}},
        {"action": "check_log",
         "params": {"service": "app", "pattern": "FATAL", "absent": True}},
        {"action": "check_log",
         "params": {"service": "app", "pattern": "ERROR.*health", "absent": True}},
        {"action": "check_log", "params": {"service": "app", "pattern": "ERROR"}},
    ])
    # absent=true 反转为"命中数==0 才过"（Spec 03 §9.3）；缺省行为向后兼容
    assert [r.passed for r in results] == [True, True, False, True]


def test_empty_steps_vacuous_pass():
    results = _run(FakeRuntime(), [])
    assert results == []  # 0 步全过（空真；生成期已由四段式校验拦截）


def test_invalid_action_raises_out_of_step_capture():
    """词表外动作在 model_validate 就地抛错，逃出单步异常捕获（Spec 07 §3.3）。"""
    with pytest.raises(Exception, match="非法 DSL 动作"):
        _run(FakeRuntime(), [{"action": "restart_service", "params": {}}])


def test_single_step_runtime_exception_captured():
    """单步运行期异常（json_path 不存在）捕获为该步失败，不中断后续步骤。"""
    rt = FakeRuntime(files={"api/health.json": '{"status": "ok"}'})
    results = _run(rt, [
        {"action": "call_api", "params": {"method": "GET", "path": "/health"}},
        {"action": "assert_response",
         "params": {"json_path": "missing.path", "expect": "x"}},
        {"action": "assert_response",
         "params": {"json_path": "status", "expect": "ok"}},
    ])
    assert [r.passed for r in results] == [True, False, True]
