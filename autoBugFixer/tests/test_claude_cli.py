"""claude -p 修复通道测试（与 test_codex_cli.py 同模式：全部离线）。

argv 构造纯本地断言；子进程执行点 monkeypatch 模拟；全链路经
ScriptedCodexCLI 桩注入（claude 驱动配置下验证驱动无关性）。
"""

from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from autobugfixer.features.fixing.claude import (
    ClaudeCodeCLI,
    claude_preflight,
    extract_usage,
    parse_result,
)
from autobugfixer.features.fixing.codex import CodexError, ScriptedCodexCLI
from autobugfixer.features.fixing.driver import build_fix_driver, fix_driver_preflight
from autobugfixer.adapters.platform import BugTicketData
from autobugfixer.common.core.config import Settings
from autobugfixer.common.core.models import LLMUsage
from autobugfixer.common.core.state import TaskState
from autobugfixer.features.ingest.ingestion import ingest_bug


# ---------- argv 构造（纯本地） ----------

def test_claude_argv_construction(tmp_path):
    cli = ClaudeCodeCLI("claude", model="claude-sonnet-4-5", timeout=120,
                        permission_mode="acceptEdits",
                        allowed_tools="Read,Edit,Write,Glob,Grep,Bash", max_turns=30)
    argv = cli.build_argv("修复 health")
    assert argv[0] == "claude"
    assert argv[1] == "-p"
    assert argv[2] == "修复 health"
    assert argv[argv.index("--output-format") + 1] == "json"
    assert argv[argv.index("--permission-mode") + 1] == "acceptEdits"
    assert argv[argv.index("--allowedTools") + 1] == "Read,Edit,Write,Glob,Grep,Bash"
    assert argv[argv.index("--model") + 1] == "claude-sonnet-4-5"
    assert argv[argv.index("--max-turns") + 1] == "30"
    # 参数列表形式，不经 shell：无字符串拼接痕迹
    assert isinstance(argv, list) and all(isinstance(a, str) for a in argv)


def test_claude_argv_omits_optional_flags(tmp_path):
    argv = ClaudeCodeCLI("claude", allowed_tools="", max_turns=0).build_argv("p")
    assert "--model" not in argv and "--allowedTools" not in argv and "--max-turns" not in argv


# ---------- 结果 JSON 解析与用量提取（固定输入） ----------

SAMPLE_RESULT = json.dumps({
    "type": "result", "subtype": "success", "is_error": False, "num_turns": 3,
    "result": "修复完成：已将 status 修正为 ok。",
    "usage": {"input_tokens": 100, "cache_creation_input_tokens": 20,
              "cache_read_input_tokens": 30, "output_tokens": 25},
}, ensure_ascii=False)


def test_parse_result_tolerates_bad_and_surrounding_output():
    assert parse_result("") == {}
    assert parse_result("not-json") == {}
    assert parse_result("[1, 2]") == {}  # 顶层非 dict
    # 前后混入非 JSON 文本时取首尾大括号切片
    parsed = parse_result(f"warning: x\n{SAMPLE_RESULT}\nbye")
    assert parsed["subtype"] == "success"


def test_extract_usage_sums_cache_tokens():
    result = parse_result(SAMPLE_RESULT)
    assert extract_usage(result) == (150, 25)  # 输入含缓存创建/读取


def test_extract_usage_bad_result_recorded_as_zero():
    assert extract_usage({}) == (0, 0)  # 解析失败记 0 不阻断（同 codex 通道）


# ---------- 子进程执行（monkeypatch 执行点） ----------

def _patch_run(monkeypatch, stdout=SAMPLE_RESULT, **kwargs):
    monkeypatch.setattr("autobugfixer.features.fixing.claude.subprocess.run",
                        lambda *a, **kw: SimpleNamespace(stdout=stdout, **kwargs))


def test_claude_run_parses_summary_and_usage(monkeypatch, tmp_path):
    seen = {}

    def fake_run(argv, cwd=None, capture_output=None, text=None, timeout=None):
        seen["argv"], seen["cwd"] = argv, cwd
        return SimpleNamespace(returncode=0, stdout=SAMPLE_RESULT, stderr="")

    monkeypatch.setattr("autobugfixer.features.fixing.claude.subprocess.run", fake_run)
    result = ClaudeCodeCLI().run("p", tmp_path)
    assert result.summary == "修复完成：已将 status 修正为 ok。"
    assert result.tokens_in == 150 and result.tokens_out == 25
    assert seen["cwd"] == str(tmp_path)  # 工作区经 cwd 注入（无 --cd 参数）
    assert result.raw_log


def test_claude_is_error_raises(monkeypatch, tmp_path):
    payload = json.dumps({"type": "result", "subtype": "error_during_execution",
                          "is_error": True, "result": "工具被权限拒绝"})
    _patch_run(monkeypatch, stdout=payload, returncode=0, stderr="")
    with pytest.raises(CodexError, match="claude -p 执行出错"):
        ClaudeCodeCLI().run("p", tmp_path)


def test_claude_nonzero_exit_raises(monkeypatch, tmp_path):
    _patch_run(monkeypatch, returncode=2, stderr="boom")
    with pytest.raises(CodexError, match="退出码 2"):
        ClaudeCodeCLI().run("p", tmp_path)


def test_claude_timeout_kills_attempt(monkeypatch, tmp_path):
    def hang(*a, **kw):
        raise subprocess.TimeoutExpired(["claude"], 1)

    monkeypatch.setattr("autobugfixer.features.fixing.claude.subprocess.run", hang)
    with pytest.raises(CodexError, match="超时"):
        ClaudeCodeCLI(timeout=1).run("p", tmp_path)


def test_claude_missing_cli_raises(monkeypatch, tmp_path):
    def not_found(*a, **kw):
        raise FileNotFoundError("claude")

    monkeypatch.setattr("autobugfixer.features.fixing.claude.subprocess.run", not_found)
    with pytest.raises(CodexError, match="未找到 claude CLI"):
        ClaudeCodeCLI().run("p", tmp_path)


def test_claude_unreadable_output_tolerated(monkeypatch, tmp_path):
    """退出码 0 但 stdout 非 JSON：summary 空、用量记 0，不阻断（同 codex 容错语义）。"""
    _patch_run(monkeypatch, stdout="", returncode=0, stderr="")
    result = ClaudeCodeCLI().run("p", tmp_path)
    assert result.summary == "" and (result.tokens_in, result.tokens_out) == (0, 0)


# ---------- 预检与驱动工厂 ----------

def test_claude_preflight_reports_missing_cli_and_auth(monkeypatch, tmp_path):
    monkeypatch.setattr("autobugfixer.features.fixing.claude.shutil.which", lambda _: None)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)  # 无 ~/.claude
    errors = claude_preflight(Settings())
    assert any("claude CLI" in e for e in errors)
    assert any("ANTHROPIC_API_KEY" in e or "claude login" in e for e in errors)


def test_claude_preflight_passes_with_cli_and_env_key(monkeypatch):
    monkeypatch.setattr("autobugfixer.features.fixing.claude.shutil.which", lambda _: "/usr/bin/claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert claude_preflight(Settings()) == []


def test_build_fix_driver_claude_by_setting(tmp_path):
    s = Settings(database_url=f"sqlite:///{tmp_path}/t.db",
                 fix_driver="claude", claude_model="claude-sonnet-4-5",
                 claude_timeout=300.0)
    driver = build_fix_driver(s)
    assert isinstance(driver, ClaudeCodeCLI)
    assert driver.model == "claude-sonnet-4-5" and driver.timeout == 300.0


def test_fix_driver_preflight_routes_claude(monkeypatch, tmp_path):
    monkeypatch.setattr("autobugfixer.features.fixing.claude.shutil.which", lambda _: None)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    s = Settings(database_url=f"sqlite:///{tmp_path}/t.db", fix_driver="claude")
    assert any("claude" in e for e in fix_driver_preflight(s))
    assert not any("DEEPSEEK" in e for e in fix_driver_preflight(s))  # 分流不串扰


# ---------- 桩注入全链路（claude 驱动配置 + ScriptedCodexCLI 桩） ----------

def _ingest(session_factory, settings, repo, bug_id="BUG-CL1") -> int:
    data = BugTicketData(
        platform_bug_id=bug_id, title="健康检查接口返回 fail",
        description="d", repro_steps="s", expected="ok", actual="fail",
        env_version="v1", repo_url=str(repo), affected_modules=["web"])
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        return task.id


def test_claude_driver_stub_full_pipeline(make_orchestrator, session_factory,
                                          settings, repo, environment):
    """fix_driver=claude 配置下桩注入走通全链路；用量留痕模型名带 claude 前缀。"""
    settings.fix_driver = "claude"
    task_id = _ingest(session_factory, settings, repo)
    orchestrator = make_orchestrator(codex=ScriptedCodexCLI())
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED
    with session_factory() as s:
        usage = s.scalars(select(LLMUsage).where(
            LLMUsage.task_id == task_id, LLMUsage.stage == "fixing")).all()
        assert usage and usage[0].model == "claude:default"
