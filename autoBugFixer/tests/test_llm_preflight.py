"""LLM 启动预检测试（Spec 02 B0）：静态校验 + 连通探测 + 三启动点拦截口径。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from autobugfixer.config import Settings
from autobugfixer.services.llm_gateway import LLMGateway, ScriptedFakeChatModel


def _settings(tmp_path, **overrides) -> Settings:
    base = dict(
        database_url=f"sqlite:///{tmp_path}/preflight.db",
        llm_mode="fake",
        workspace_root=str(tmp_path / "ws"),
        env_root=str(tmp_path / "env"),
    )
    base.update(overrides)
    return Settings(**base)


class _BoomModel:
    """探测替身：invoke 即抛连接错误（模拟网络不通）。"""

    def invoke(self, *_args, **_kwargs):
        raise ConnectionError("network unreachable")


# ---------- Gateway 预检本体 ----------

def test_preflight_fake_mode_passes_without_probe(settings):
    """B0-3：fake 模式零依赖直接通过，不联网。"""
    report = LLMGateway(settings).preflight()
    assert report.ok and report.static_ok and report.probe_error is None


def test_preflight_static_missing_key(tmp_path):
    """A7/B0-1：anthropic 模式缺 api_key -> 静态错误提及环境变量名。"""
    s = _settings(tmp_path, llm_mode="anthropic", anthropic_api_key=None)
    report = LLMGateway(s).preflight()
    assert not report.static_ok and not report.ok
    assert any("ANTHROPIC_API_KEY" in e for e in report.static_errors)


def test_preflight_static_invalid_mode(tmp_path):
    """B0-1：非法 llm_mode -> 静态错误。"""
    s = _settings(tmp_path, llm_mode="bogus")
    report = LLMGateway(s).preflight()
    assert not report.static_ok
    assert any("llm_mode" in e for e in report.static_errors)


def test_preflight_probe_failure_degrades_not_blocks(tmp_path, monkeypatch):
    """A8/B0-2：静态通过但探测失败 -> 报告携带错误但区分于静态错误。"""
    s = _settings(tmp_path, llm_mode="anthropic", anthropic_api_key="dummy")
    monkeypatch.setattr(LLMGateway, "_probe_model", lambda self: _BoomModel())
    report = LLMGateway(s).preflight()
    assert report.static_ok          # 配置本身没错
    assert not report.ok             # 但连通性不行
    assert "ConnectionError" in report.probe_error


def test_preflight_probe_success(tmp_path, monkeypatch):
    """B0-2：探测成功 -> ok。"""
    s = _settings(tmp_path, llm_mode="anthropic", anthropic_api_key="dummy")
    monkeypatch.setattr(LLMGateway, "_probe_model",
                        lambda self: ScriptedFakeChatModel())
    report = LLMGateway(s).preflight()
    assert report.ok


# ---------- 启动点拦截口径 ----------

def test_cli_preflight_blocks_before_import(tmp_path, capsys):
    """A7：CLI --run-analysis 且配置缺 key -> 非零退出，不执行导入。"""
    from autobugfixer.cli import main

    csv_path = tmp_path / "bugs.csv"
    csv_path.write_text("编号,标题\nBUG-1,标题\n", encoding="utf-8")
    s = _settings(tmp_path, llm_mode="anthropic", anthropic_api_key=None)
    rc = main([str(csv_path), "--run-analysis"], settings=s)
    assert rc == 2
    assert "ANTHROPIC_API_KEY" in capsys.readouterr().err


def test_scheduler_preflight_refuses_to_build(tmp_path):
    """A7：调度器构建即预检，配置错抛 LLMPreflightError。"""
    from autobugfixer.scheduler_cli import build_scheduler
    from autobugfixer.services.llm_gateway import LLMPreflightError

    s = _settings(tmp_path, llm_mode="anthropic", anthropic_api_key=None)
    with pytest.raises(LLMPreflightError, match="ANTHROPIC_API_KEY"):
        build_scheduler(s)


def test_api_static_error_refuses_start(tmp_path):
    """A7：API 静态配置错 -> create_app 拒绝启动。"""
    from autobugfixer.api.app import create_app
    from autobugfixer.services.llm_gateway import LLMPreflightError

    s = _settings(tmp_path, llm_mode="anthropic", anthropic_api_key=None)
    with pytest.raises(LLMPreflightError, match="预检"):
        create_app(s)


def test_api_probe_error_degrades_and_health_exposes(tmp_path, monkeypatch):
    """A8：API 探测失败仍可启动，/api/health 暴露 degraded + llm 错误。"""
    from autobugfixer.api.app import create_app

    s = _settings(tmp_path, llm_mode="anthropic", anthropic_api_key="dummy")
    monkeypatch.setattr(LLMGateway, "_probe_model", lambda self: _BoomModel())
    app = create_app(s)  # 静态通过 -> 服务可启动
    body = TestClient(app).get("/api/health").json()
    assert body["status"] == "degraded"
    assert "network unreachable" in body["llm"]["probe"]
    assert body["llm"]["mode"] == "anthropic"


def test_api_health_ok_in_fake_mode(settings, session_factory, platform):
    """B0-3：fake 模式 /api/health 全绿。"""
    from autobugfixer.api.app import create_app

    app = create_app(settings, platform=platform)
    body = TestClient(app).get("/api/health").json()
    assert body == {"status": "ok", "llm": {"mode": "fake", "probe": "ok"}}
