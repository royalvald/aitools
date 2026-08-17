"""codex exec 修复通道测试（Spec 05 §8：A5/A6/A7 单测 + A8-A10 出口校验分支）。

全部离线：argv 构造纯本地断言；子进程执行点 monkeypatch 模拟；
出口校验分支经 ScriptedCodexCLI 桩注入全链路触发。
"""

from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from autobugfixer.adapters.codex_cli import (
    CodexError,
    CodexCLI,
    ScriptedCodexCLI,
    extract_usage,
    parse_events,
)
from autobugfixer.adapters.bug_platform import BugTicketData
from autobugfixer.config import Settings
from autobugfixer.models import FixRecord, LLMUsage
from autobugfixer.pipeline.state import TaskState
from autobugfixer.services.ingestion import ingest_bug


# ---------- A5：argv 构造（纯本地） ----------

def test_codex_argv_construction(tmp_path):
    cli = CodexCLI("codex", model="gpt-5-codex", timeout=120, sandbox="workspace-write")
    argv = cli.build_argv("修复 health", tmp_path, tmp_path / "last.txt")
    assert argv[0] == "codex"
    assert argv[1] == "exec"
    assert argv[2] == "修复 health"
    assert argv[argv.index("--cd") + 1] == str(tmp_path)
    assert argv[argv.index("-s") + 1] == "workspace-write"
    assert "--json" in argv
    assert argv[argv.index("--output-last-message") + 1] == str(tmp_path / "last.txt")
    assert "--skip-git-repo-check" in argv
    assert argv[argv.index("--model") + 1] == "gpt-5-codex"
    # 参数列表形式，不经 shell：无字符串拼接痕迹
    assert isinstance(argv, list) and all(isinstance(a, str) for a in argv)


def test_codex_argv_omits_model_when_unset(tmp_path):
    argv = CodexCLI("codex").build_argv("p", tmp_path, tmp_path / "l.txt")
    assert "--model" not in argv


# ---------- A6：事件流解析与用量提取（固定 JSONL 输入） ----------

SAMPLE_JSONL = "\n".join([
    json.dumps({"type": "event_msg",
                "msg": {"type": "agent_message", "message": "开始分析"}}),
    "not-a-json-line",
    json.dumps({"type": "token_count", "info": {"total_token_usage": {
        "input_tokens": 120, "output_tokens": 30, "cached_input_tokens": 10}}}),
    json.dumps({"type": "token_count", "info": {"last_token_usage": {
        "input_tokens": 40, "output_tokens": 5}}}),
])


def test_parse_events_tolerates_bad_lines():
    events = parse_events(SAMPLE_JSONL)
    assert len(events) == 3  # 非法行跳过
    assert events[0]["type"] == "event_msg"


def test_extract_usage_takes_cumulative_max():
    events = parse_events(SAMPLE_JSONL)
    assert extract_usage(events) == (120, 30)


def test_extract_usage_empty_events_recorded_as_zero():
    assert extract_usage([]) == (0, 0)  # 解析失败记 0 不阻断（Spec 05 §7）


# ---------- A7：五类异常（缺失/超时/非零退出/输出不可读） ----------

def _patch_run(monkeypatch, **kwargs):
    monkeypatch.setattr("autobugfixer.adapters.codex_cli.subprocess.run",
                        lambda *a, **kw: SimpleNamespace(**kwargs))


def test_codex_missing_cli_raises(monkeypatch, tmp_path):
    def not_found(*a, **kw):
        raise FileNotFoundError("codex")

    monkeypatch.setattr("autobugfixer.adapters.codex_cli.subprocess.run", not_found)
    with pytest.raises(CodexError, match="未找到 codex CLI"):
        CodexCLI().run("p", tmp_path)


def test_codex_timeout_kills_attempt(monkeypatch, tmp_path):
    def hang(*a, **kw):
        raise subprocess.TimeoutExpired(["codex"], 1)

    monkeypatch.setattr("autobugfixer.adapters.codex_cli.subprocess.run", hang)
    with pytest.raises(CodexError, match="超时"):
        CodexCLI(timeout=1).run("p", tmp_path)


def test_codex_nonzero_exit_raises(monkeypatch, tmp_path):
    _patch_run(monkeypatch, returncode=2, stdout="", stderr="boom")
    with pytest.raises(CodexError, match="退出码 2"):
        CodexCLI().run("p", tmp_path)


def test_codex_run_reads_last_message_and_usage(monkeypatch, tmp_path):
    def fake_run(argv, cwd=None, capture_output=None, text=None, timeout=None):
        last = argv[argv.index("--output-last-message") + 1]
        with open(last, "w", encoding="utf-8") as f:
            f.write("修复完成：已将 status 修正为 ok。")
        return SimpleNamespace(returncode=0, stdout=SAMPLE_JSONL, stderr="")

    monkeypatch.setattr("autobugfixer.adapters.codex_cli.subprocess.run", fake_run)
    result = CodexCLI().run("p", tmp_path)
    assert result.summary == "修复完成：已将 status 修正为 ok。"
    assert result.tokens_in == 120 and result.tokens_out == 30
    assert result.events


def test_codex_preflight_reports_missing_cli_and_auth(monkeypatch, tmp_path):
    from autobugfixer.adapters.codex_cli import codex_preflight

    monkeypatch.setattr("autobugfixer.adapters.codex_cli.shutil.which", lambda _: None)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)  # 无 ~/.codex/auth.json
    errors = codex_preflight(Settings())
    assert any("codex CLI" in e for e in errors)
    assert any("OPENAI_API_KEY" in e or "codex login" in e for e in errors)


# ---------- A1 类：桩注入全链路（计量 + 留痕，Spec 05 R1/R6） ----------

def _ingest(session_factory, settings, repo, bug_id="BUG-CX1") -> int:
    data = BugTicketData(
        platform_bug_id=bug_id, title="健康检查接口返回 fail",
        description="d", repro_steps="s", expected="ok", actual="fail",
        env_version="v1", repo_url=str(repo), affected_modules=["web"])
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        return task.id


def test_codex_stub_records_usage_and_fix_record(
        make_orchestrator, session_factory, settings, repo, environment):
    task_id = _ingest(session_factory, settings, repo)
    stub = ScriptedCodexCLI()
    orchestrator = make_orchestrator(codex=stub)
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED

    with session_factory() as s:
        fix = s.scalar(select(FixRecord).where(FixRecord.task_id == task_id))
        assert fix.summary == "修复完成：已将 status 修正为 ok。"
        assert "api/health.json" in fix.changed_files
        assert fix.raw_log == ""  # 桩无事件流原文
        usage = s.scalars(select(LLMUsage).where(
            LLMUsage.task_id == task_id, LLMUsage.stage == "fixing")).all()
        assert usage and usage[0].tokens_in == 48 and usage[0].tokens_out == 12


def test_fixing_failure_on_codex_error_goes_failed(
        make_orchestrator, session_factory, settings, repo, environment):
    """codex 调用失败（CodexError）-> 本次尝试 FAILED（断点续跑）。"""

    class ExplodingCLI:
        def run(self, prompt, workspace):
            raise CodexError("codex exec 退出码 1: boom")

    task_id = _ingest(session_factory, settings, repo, "BUG-CX2")
    orchestrator = make_orchestrator(codex=ExplodingCLI())
    assert orchestrator.run_until_blocked(task_id) == TaskState.FAILED


# ---------- A8-A10：出口校验四分支 ----------

def test_forbidden_path_goes_manual(make_orchestrator, session_factory,
                                    settings, repo, environment):
    """A8：禁改路径命中 -> MANUAL（安全红线不重试），FixRecord 留痕。"""
    settings.forbidden_paths = ["*.pem", "api/*"]
    task_id = _ingest(session_factory, settings, repo, "BUG-CX3")
    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.MANUAL
    with session_factory() as s:
        fix = s.scalar(select(FixRecord).where(FixRecord.task_id == task_id))
        assert fix is not None and fix.changed_files  # 留痕后再判失败


def test_zero_change_goes_failed(make_orchestrator, session_factory,
                                 settings, repo, environment):
    """A9：零变更 -> FAILED（可续跑）。"""
    task_id = _ingest(session_factory, settings, repo, "BUG-CX4")
    orchestrator = make_orchestrator(codex=ScriptedCodexCLI(writes={}))
    assert orchestrator.run_until_blocked(task_id) == TaskState.FAILED
    with session_factory() as s:
        fix = s.scalar(select(FixRecord).where(FixRecord.task_id == task_id))
        assert fix.changed_files == [] and fix.diff == ""


def test_duplicate_diff_goes_learning(make_orchestrator, session_factory,
                                      settings, repo, environment):
    """A10：重试环中与历史尝试相同 diff -> LEARNING 提前终止（失败分支）。"""
    task_id = _ingest(session_factory, settings, repo, "BUG-CX5")
    stub = ScriptedCodexCLI()  # 每次写相同内容 -> 相同 diff 哈希
    failing_plan = [
        {"complete": True, "missing": [], "suggestions": []},
        {"env_requirements": "env",
         "steps": [
             {"action": "input", "params": {"selector": "#env", "value": "v1"}},
             {"action": "call_api", "params": {"method": "GET", "path": "/health"}},
             {"action": "assert_response",
              "params": {"json_path": "status", "expect": "never-match"}}],
         "expected_results": [], "function_points": [], "regression_scope": ""},
    ]
    orchestrator = make_orchestrator(failing_plan, codex=stub)
    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.WAIT_DISCUSS  # 重复 diff 提前终止 -> 失败分支讨论
    with session_factory() as s:
        fixes = s.scalars(select(FixRecord).where(
            FixRecord.task_id == task_id).order_by(FixRecord.attempt)).all()
        assert len(fixes) == 2  # 第二次尝试留痕后触发重复判定
        assert fixes[0].diff_hash == fixes[1].diff_hash
