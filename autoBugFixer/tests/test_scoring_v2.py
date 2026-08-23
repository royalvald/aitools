"""评分 v2 引擎测试（Spec 04 §8：rubric 加载 / 判定表单 / 本地映射 / 四维权重 / 代码实证）。

fake 模式判定表单固定输出：single_logic + repro_executable + has_location_desc，
fake 方案 5 步无 DB —— 期望四维分完全确定（映射器纯本地可复算）：
  fix    = 42.5（30-55 中点）- 5（repro_executable）        = 37.5
  blast  = 25.0（15-35 中点，单模块无 modules_ge_2）
  locate = 50.0（40-60 中点，未命中 desc_has_stack）
  verify = 27.5（20-35 中点）+ 15（plan_db_or_5steps：>=5 步） = 42.5
  total  = 0.3*50 + 0.3*37.5 + 0.2*42.5 + 0.2*25            = 39.75
"""

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from autobugfixer.adapters.platform import BugTicketData
from autobugfixer.common.core.models import AuditLog, Repo, StrategyVersion, Task, VerificationPlan
from autobugfixer.features.scoring.schemas import CodeEvidence, JudgmentForm, LocateSignals
from autobugfixer.features.scoring.v2 import (
    extract_keywords,
    map_judgment,
    search_repos,
)
from autobugfixer.common.core.state import TaskState
from autobugfixer.common.prompts.rubric import load_rubric, parse_rubric
from autobugfixer.features.ingest.ingestion import ingest_bug

RUBRIC = load_rubric()


# ---------- rubric 加载器（§8.3 解析约定） ----------

def test_rubric_loader_parses_version_and_tables():
    assert RUBRIC.version == "v1"
    assert set(RUBRIC.types) == {"copy_text", "param_check", "single_logic",
                                 "cross_module", "data_arch"}
    prior = RUBRIC.types["single_logic"]
    assert (prior.fix.lo, prior.fix.hi) == (30, 55)
    assert (prior.blast.lo, prior.blast.hi) == (15, 35)
    assert {f.id for f in RUBRIC.factors} >= {"repro_executable", "desc_has_stack",
                                              "modules_ge_2", "plan_db_or_5steps"}
    assert RUBRIC.factor("modules_ge_2").delta == 15
    assert RUBRIC.factor("repro_executable").delta == -5
    assert [r.key for r in RUBRIC.locate_rows] == ["has_stack", "has_location_desc", "none"]
    assert "# 评分评价标准" in RUBRIC.source_text  # 原文直传可用


def test_rubric_parser_rejects_missing_version():
    with pytest.raises(ValueError, match="版本标识"):
        parse_rubric("## 缺陷类型先验表\n| a | b | c | d | e |\n|---|---|---|---|---|\n| x | y | z | 1-2 | 3-4 |\n")


# ---------- 判定表单 Schema（§8.5） ----------

def test_judgment_form_rejects_unknown_bug_type():
    with pytest.raises(ValidationError, match="非法缺陷类型"):
        JudgmentForm(bug_type="bogus")
    form = JudgmentForm(bug_type="cross_module",
                        locate_signals=LocateSignals(has_stack=True))
    assert form.locate_signals.has_stack is True
    assert form.code_evidence.triggered is False


# ---------- 本地映射器（纯本地全确定性，§8.7 触点 7） ----------

def _form(bug_type="single_logic", factors=(), has_stack=False, has_location_desc=True):
    return JudgmentForm(bug_type=bug_type, factors_hit=list(factors),
                        locate_signals=LocateSignals(has_stack=has_stack,
                                                     has_location_desc=has_location_desc))


def test_mapper_fake_form_pins_four_dims():
    dims = map_judgment(RUBRIC, _form(factors=["repro_executable"]),
                        affected_modules=["web"],
                        plan_steps=[{"action": "input"}, {"action": "call_api"},
                                    {"action": "assert_response"}, {"action": "click"},
                                    {"action": "assert_response"}])
    assert dims.as_dict() == {"locate": 50.0, "fix": 37.5, "verify": 42.5, "blast": 25.0}


def test_mapper_locate_rows_and_stack_factor():
    # 含堆栈 -> 10-20 中点 15；desc_has_stack 再 -10 -> 5
    dims = map_judgment(RUBRIC, _form(factors=["desc_has_stack"], has_stack=True,
                                      has_location_desc=False),
                        affected_modules=["web"], plan_steps=[])
    assert dims.locate == 5.0
    # 无任何位置线索 -> 65-85 中点 75
    dims = map_judgment(RUBRIC, _form(has_stack=False, has_location_desc=False),
                        affected_modules=["web"], plan_steps=[])
    assert dims.locate == 75.0


def test_mapper_local_factors_and_clamp():
    # data_arch 75-95/60-90 + modules_ge_2(+15) + 实证 4 文件(+20) -> 波及 clamp 100
    dims = map_judgment(RUBRIC, _form(bug_type="data_arch", has_location_desc=False),
                        affected_modules=["a", "b"], plan_steps=[
                            {"action": "query_db"}, {"action": "input"},
                            {"action": "call_api"}, {"action": "assert_response"},
                            {"action": "click"}],
                        code_evidence=CodeEvidence(triggered=True, suspected_files=[
                            "a.py", "b.py", "c.py", "d.py"]))
    assert dims.blast == 100.0  # 75 + 15 + 20 越界收敛
    assert dims.locate == 65.0  # 75（none 行）- 10（实证定位到疑似点）
    assert dims.verify == 60.0  # 35-55 中点（含 DB）+ 15（plan_db_or_5steps）


def test_mapper_verify_rows_by_plan_shape():
    for steps, expected in (
        ([{"action": "click"}], 17.5),                       # <3 步无 DB
        ([{"action": "click"}] * 3, 27.5),                   # 3-5 步
        ([{"action": "click"}] * 6, 60.0),                   # >5 步（行 45 + 因子 15）
        ([{"action": "assert_db"}] * 1, 60.0),               # 含 DB 断言（同上）
    ):
        dims = map_judgment(RUBRIC, _form(), affected_modules=["web"], plan_steps=steps)
        assert dims.verify == expected


# ---------- 关键词与仓库检索（§8.6） ----------

def test_extract_keywords_and_search_repos(tmp_path):
    repo = tmp_path / "svc"
    (repo / "api").mkdir(parents=True)
    (repo / "api" / "pay.py").write_text("def callback():\n    入账逻辑 bug\n", encoding="utf-8")
    (repo / "api" / "other.py").write_text("无关内容\n", encoding="utf-8")
    keywords = extract_keywords("支付 callback 重复入账")
    assert any("入账" in k or "callback" in k for k in keywords)

    row = Repo(path=str(repo), branch="main", status="available")
    snippets = search_repos([row], keywords)
    assert len(snippets) == 1  # 仅命中文本文件
    assert "pay.py" in snippets[0]  # 首个命中行（callback 关键词命中第 1 行）


def test_search_repos_skips_binary_and_git(tmp_path):
    repo = tmp_path / "svc"
    (repo / ".git").mkdir(parents=True)
    (repo / ".git" / "config").write_text("入账", encoding="utf-8")
    (repo / "logo.png").write_bytes(b"\x89PNG " + "入账".encode("utf-8"))
    row = Repo(path=str(repo), branch="main", status="available")
    assert search_repos([row], ["入账"]) == []


# ---------- 端到端：v2 引擎（fake 判定表单） ----------

def _ingest(session_factory, settings, repo, bug_id="BUG-V2A") -> int:
    data = BugTicketData(
        platform_bug_id=bug_id, title="健康检查接口返回 fail",
        description="d", repro_steps="s", expected="ok", actual="fail",
        env_version="v1", repo_url=str(repo), affected_modules=["web"])
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        return task.id


def test_v2_engine_end_to_end(make_orchestrator, session_factory, settings,
                              repo, environment):
    settings.scoring_engine = "v2"
    task_id = _ingest(session_factory, settings, repo)
    assert make_orchestrator().run_until_blocked(task_id) == TaskState.CLOSED

    with session_factory() as s:
        task = s.get(Task, task_id)
        detail = task.score_detail
        assert task.priority_score == 39.75  # 确定性映射（见模块 docstring 推演）
        assert detail["weights"]["version"] == "v2"
        assert detail["rubric_version"] == "v1"
        assert detail["bug_type"] == "single_logic"
        assert detail["factors_hit"] == ["repro_executable"]
        assert detail["rationale"]  # 判定证据即理由
        assert detail["locate"] == 50.0 and detail["blast"] == 25.0
        # fix_approach（Spec 03 §9.4 -> 触点 8）注入评分 prompt 证据
        plan = s.scalar(select(VerificationPlan).where(
            VerificationPlan.task_id == task_id))
        assert plan.fix_approach  # 已随 v2 prompt 消费


def test_v2_strategy_four_key_weights_and_threshold(make_orchestrator, session_factory,
                                                    settings, repo, environment):
    """四键策略部分合并 + 阈值覆盖（§8.4 兼容迁移：缺键沿用配置默认）。"""
    settings.scoring_engine = "v2"
    with session_factory() as s:
        s.add(StrategyVersion(version=1, active=True, weights={
            "locate": 1.0, "fix": 0.0, "verify": 0.0, "blast": 0.0, "threshold": 45.0}))
        s.commit()
    task_id = _ingest(session_factory, settings, repo, "BUG-V2B")
    final = make_orchestrator().run_until_blocked(task_id)
    assert final == TaskState.MANUAL  # total = locate 50 >= 阈值 45
    with session_factory() as s:
        detail = s.get(Task, task_id).score_detail
        assert detail["weights"]["version"] == "strategy:v1"
        assert detail["weights"]["locate"] == 1.0
        assert detail["threshold"] == 45.0


def test_v2_cross_module_triggers_code_evidence(make_orchestrator, session_factory,
                                                settings, repo, environment):
    """复杂类型触发第二次调用：仓库只读检索片段进实证 prompt（§8.6）。"""
    settings.scoring_engine = "v2"
    (repo / "api" / "health.py").write_text("def check():\n    健康检查 fail\n",
                                            encoding="utf-8")
    # 队列按调用顺序消费：完整性 -> 仓库画像 -> 方案 -> 判定表单；代码实证走默认 fake 路由
    fake_responses = [
        {"complete": True, "missing": [], "suggestions": []},
        {"summary": "fake 画像：健康检查服务仓库", "tech_stack": ["python"],
         "key_dirs": ["api"], "entry_points": [], "bug_relevance": "包含 /health 接口"},
        {"env_requirements": "env", "steps": [
            {"action": "input", "params": {"selector": "#env", "value": "v1"}},
            {"action": "call_api", "params": {"method": "GET", "path": "/health"}},
            {"action": "assert_response",
             "params": {"json_path": "status", "expect": "ok"}}],
         "expected_results": [], "function_points": [], "regression_scope": ""},
        {"bug_type": "cross_module", "type_evidence": "健康检查与服务注册契约不一致",
         "factors_hit": ["repro_executable"],
         "locate_signals": {"has_stack": False, "has_location_desc": True},
         "code_evidence": {"triggered": False}},
    ]
    orchestrator = make_orchestrator(fake_responses)
    task_id = _ingest(session_factory, settings, repo, "BUG-V2C")
    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.CLOSED

    with session_factory() as s:
        audits = s.scalars(select(AuditLog).where(
            AuditLog.task_id == task_id, AuditLog.action == "code_evidence")).all()
        assert audits and audits[0].detail["triggered"] is True
        assert audits[0].detail["snippets"] >= 1  # 检索到仓库片段
        detail = s.get(Task, task_id).score_detail
        assert detail["bug_type"] == "cross_module"
        assert detail["code_evidence_triggered"] is True


def test_v2_code_evidence_prompt_includes_repo_snippet(make_orchestrator, session_factory,
                                                       settings, repo, environment):
    """实证 prompt 携带关联仓库只读检索片段（RecordingGateway 捕获）。"""
    settings.scoring_engine = "v2"
    (repo / "api" / "health.py").write_text("def check():\n    健康检查 fail\n",
                                            encoding="utf-8")
    prompts: list[str] = []

    class RecordingLLM:
        def analyze(self, prompt, schema, *, task_id, stage, session=None):
            prompts.append(prompt)
            if schema.__name__ == "JudgmentForm":
                return JudgmentForm(bug_type="cross_module",
                                    type_evidence="契约不一致",
                                    locate_signals=LocateSignals(has_location_desc=True))
            if schema.__name__ == "CodeEvidence":
                return CodeEvidence(triggered=True, suspected_files=["api/health.py"])
            if schema.__name__ == "CompletenessEval":
                from autobugfixer.features.completeness.schemas import CompletenessEval
                return CompletenessEval(complete=True)
            if schema.__name__ == "RepoProfile":
                from autobugfixer.features.completeness.schemas import RepoProfile
                return RepoProfile(summary="健康检查服务仓库", tech_stack=["python"],
                                   key_dirs=["api"])
            if schema.__name__ == "PlanOutput":
                from autobugfixer.features.planning.schemas import PlanOutput
                return PlanOutput(steps=[
                    {"action": "input", "params": {"selector": "#env", "value": "v1"}},
                    {"action": "call_api", "params": {"method": "GET", "path": "/health"}},
                    {"action": "assert_response",
                     "params": {"json_path": "status", "expect": "ok"}}])
            raise AssertionError(f"unexpected schema {schema}")

        def check_budget(self, *a, **k):
            pass

        def record_usage(self, *a, **k):
            pass

    from autobugfixer.features.fixing.codex import ScriptedCodexCLI
    from autobugfixer.adapters.env import LocalExecutor
    from autobugfixer.features.intervention.notifier import LogNotifier
    from autobugfixer.adapters.env.whitelist import CommandWhitelist
    from autobugfixer.runtime.orchestrator import Orchestrator

    class _NoopPlatform:
        def list_bugs(self, since=None):
            return []

        def get_bug(self, bug_id):
            raise KeyError(bug_id)

        def update_bug(self, bug_id, patch):
            pass

    orchestrator = Orchestrator(
        session_factory, llm=RecordingLLM(), platform=_NoopPlatform(),
        executor=LocalExecutor(settings.env_root, CommandWhitelist(settings.cmd_whitelist)),
        notifier=LogNotifier(), settings=settings, codex=ScriptedCodexCLI())

    task_id = _ingest(session_factory, settings, repo, "BUG-V2D")
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED
    evidence_prompts = [p for p in prompts if "# 代码实证" in p]
    assert evidence_prompts, "复杂类型必须触发代码实证第二次调用"
    assert "health.py" in evidence_prompts[0]  # 只读检索片段注入 prompt
