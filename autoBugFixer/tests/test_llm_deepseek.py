"""DeepSeek 分析网关测试（llm_mode=deepseek）：预检 + 模型构造 + 计量命名。"""

from __future__ import annotations

from autobugfixer.common.core.config import Settings
from autobugfixer.common.core.llm import LLMGateway, _usage_model_name


def _settings(tmp_path, **overrides) -> Settings:
    base = dict(
        database_url=f"sqlite:///{tmp_path}/deepseek.db",
        llm_mode="deepseek",
        deepseek_api_key="test-key",
        workspace_root=str(tmp_path / "ws"),
        env_root=str(tmp_path / "env"),
    )
    base.update(overrides)
    return Settings(**base)


def test_preflight_deepseek_missing_key(tmp_path):
    """deepseek 模式缺 Key -> 静态错误提及环境变量名。"""
    s = _settings(tmp_path, deepseek_api_key=None)
    report = LLMGateway(s).preflight(probe=False)
    assert not report.static_ok and not report.ok
    assert any("AUTOBUGFIXER_DEEPSEEK_API_KEY" in e for e in report.static_errors)


def test_preflight_deepseek_with_key_static_ok(tmp_path):
    """deepseek 模式配置齐全 -> 静态校验通过（probe=False 不联网）。"""
    report = LLMGateway(_settings(tmp_path)).preflight(probe=False)
    assert report.static_ok and report.ok and report.probe_error is None


def test_chat_model_deepseek_builds_openai_compat(tmp_path):
    """deepseek 模式构造 OpenAI 兼容聊天模型，模型名取 deepseek 配置。"""
    from langchain_openai import ChatOpenAI

    s = _settings(tmp_path, deepseek_model="deepseek-chat", llm_max_tokens=2048)
    model = LLMGateway(s)._chat_model()
    assert isinstance(model, ChatOpenAI)
    assert model.model_name == "deepseek-chat"


def test_usage_model_name_follows_mode(tmp_path):
    """计量模型名按模式取对应模型，不再硬编码 anthropic。"""
    assert _usage_model_name(_settings(tmp_path)) == "deepseek:deepseek-chat"
    assert _usage_model_name(_settings(
        tmp_path, llm_mode="anthropic")) == "anthropic:claude-sonnet-4-5"
    assert _usage_model_name(_settings(tmp_path, llm_mode="fake")) == "fake:"
