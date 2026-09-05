"""修复驱动工厂（Spec 05 扩展）：按 fix_driver 配置构建 codex / deepseek / claude 通道。

三者同接口（run(prompt, workspace) -> CodexRunResult，失败抛 CodexError），
修复阶段不感知具体驱动；启动点预检按驱动分流（codex/claude 查 CLI+鉴权，
deepseek 查 API Key 配置）。
"""

from __future__ import annotations

from autobugfixer.common.core.config import Settings


def build_fix_driver(settings: Settings):
    """按 fix_driver 配置构建修复驱动（codex / deepseek / claude）。"""
    if settings.fix_driver == "deepseek":
        from .deepseek import DeepSeekFixer

        return DeepSeekFixer.from_settings(settings)
    if settings.fix_driver == "claude":
        from .claude import ClaudeCodeCLI

        return ClaudeCodeCLI.from_settings(settings)
    from .codex import CodexCLI

    return CodexCLI.from_settings(settings)


def fix_driver_preflight(settings: Settings) -> list[str]:
    """修复驱动启动预检：静态配置错误列表（空列表 = 通过）。"""
    if settings.fix_driver == "codex":
        from .codex import codex_preflight

        return codex_preflight(settings)
    if settings.fix_driver == "claude":
        from .claude import claude_preflight

        return claude_preflight(settings)
    errors: list[str] = []
    if settings.fix_driver != "deepseek":
        errors.append(f"fix_driver 非法: {settings.fix_driver!r}（可选 codex / deepseek / claude）")
    if not settings.deepseek_api_key:
        errors.append("DeepSeek 修复通道未配置：设置 AUTOBUGFIXER_DEEPSEEK_API_KEY")
    return errors
