"""修复驱动工厂（Spec 05 扩展）：按 fix_driver 配置构建 codex / deepseek / claude 通道。

三者同接口（run(prompt, workspace) -> CodexRunResult，失败抛 CodexError），
修复阶段不感知具体驱动；启动点预检按驱动分流（codex/claude 查 CLI+鉴权，
deepseek 查 API Key 配置）。

生产模式（production_mode=True，P0-1 整改）预检额外强制「仅开放沙箱化通道」：
- codex：沙箱模式不得为 danger-full-access；
- claude：allowed_tools 不得含 Bash（免确认 shell = RCE 面）；
- deepseek：run_command 已内建 CommandWhitelist（fail-closed），视为达标。
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


def _production_gate(settings: Settings, errors: list[str]) -> None:
    """生产模式通道安全门禁：非沙箱化配置直接拒绝启动。"""
    if not settings.production_mode:
        return
    if settings.fix_driver == "claude":
        tools = [t.strip() for t in settings.claude_allowed_tools.split(",")]
        if "Bash" in tools:
            errors.append(
                "生产模式禁用 claude 通道 Bash 工具（免确认执行宿主机 shell）："
                "移除 AUTOBUGFIXER_CLAUDE_ALLOWED_TOOLS 中的 Bash，或改用 fix_driver=codex")
    if settings.fix_driver == "codex" and settings.codex_sandbox in (
            "danger-full-access", "full-access"):
        errors.append(
            f"生产模式禁用 codex 非沙箱模式: {settings.codex_sandbox}"
            "（保持默认 workspace-write）")


def fix_driver_preflight(settings: Settings) -> list[str]:
    """修复驱动启动预检：静态配置错误列表（空列表 = 通过）。"""
    if settings.fix_driver == "codex":
        from .codex import codex_preflight

        errors = codex_preflight(settings)
    elif settings.fix_driver == "claude":
        from .claude import claude_preflight

        errors = claude_preflight(settings)
    else:
        errors: list[str] = []
        if settings.fix_driver != "deepseek":
            errors.append(f"fix_driver 非法: {settings.fix_driver!r}（可选 codex / deepseek / claude）")
        if not settings.deepseek_api_key:
            errors.append("DeepSeek 修复通道未配置：设置 AUTOBUGFIXER_DEEPSEEK_API_KEY")
    _production_gate(settings, errors)
    return errors
