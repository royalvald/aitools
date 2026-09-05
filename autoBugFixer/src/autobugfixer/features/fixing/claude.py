"""Claude Code CLI 修复通道（Spec 05 扩展：与 codex / deepseek 并列的第三修复驱动）。

- ``ClaudeCodeCLI``：``claude -p`` headless 子进程封装。参数列表形式调用
  （不经 shell）、工作区经 cwd 注入、``--output-format json`` 单 JSON 结果
  解析最终说明与用量、超时杀进程；
- ``claude_preflight``：启动点静态预检（CLI 可执行 + 鉴权配置）；
- 与 ``CodexCLI`` 同接口（``run(prompt, workspace) -> CodexRunResult``，
  失败抛 ``CodexError``），修复阶段不感知具体驱动。

变更产物（changed_files/diff）一律由 ``compute_diff`` 独立计算，不解析
CLI 自述的文件清单作准（与 codex 通道一致）。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from autobugfixer.common.core.config import Settings
from autobugfixer.features.fixing.codex import CodexError, CodexRunResult


def parse_result(stdout: str) -> dict:
    """解析 ``--output-format json`` 的单 JSON 结果（坏输出返回空 dict，版本容错）。"""
    text = (stdout or "").strip()
    if not text:
        return {}
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        payload = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def extract_usage(result: dict) -> tuple[int, int]:
    """从结果 JSON 的 usage 提取 token 用量（输入含缓存读写；坏值记 0 不阻断）。"""
    usage = result.get("usage") or {}
    tokens_in = sum(int(usage.get(key) or 0) for key in (
        "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    tokens_out = int(usage.get("output_tokens") or 0)
    return tokens_in, tokens_out


def claude_preflight(settings: Settings | None = None) -> list[str]:
    """静态预检（Spec 05 §2.2 鉴权行同款）：CLI 可执行 + 鉴权（ANTHROPIC_API_KEY 或 claude login）。"""
    from autobugfixer.common.core.config import get_settings

    settings = settings or get_settings()
    errors: list[str] = []
    if shutil.which(settings.claude_executable) is None:
        errors.append(
            f"未找到 claude CLI: {settings.claude_executable}"
            "（安装: npm install -g @anthropic-ai/claude-code）")
    # ~/.claude 为 claude login / 首次配置后必然存在的目录（凭据本体在 macOS 走钥匙串）
    if not (os.environ.get("ANTHROPIC_API_KEY")
            or (Path.home() / ".claude").exists()):
        errors.append("claude 鉴权未配置：设置 ANTHROPIC_API_KEY 或执行 claude login")
    return errors


class ClaudeCodeCLI:
    """``claude -p`` headless 封装（修复主体在 Claude Code 内部闭环）。

    :param executable: CLI 可执行名/路径，默认 ``claude``。
    :param model: 透传 ``--model``（None 用 CLI 默认）。
    :param timeout: 单次调用超时（秒），超时杀进程。
    :param permission_mode: 权限模式，默认 ``acceptEdits``（文件编辑免确认，
        headless 必需；配合 allowed_tools 约束能力边界，对标 codex workspace-write）。
    :param allowed_tools: ``--allowedTools`` 工具白名单（空 = 不传）。默认不含
        ``Bash``（P0-1：acceptEdits + Bash 等于免确认执行宿主机 shell，RCE 面）；
        与 codex workspace-write 沙箱能力对齐，确需时显式配置并自担风险。
    :param max_turns: ``--max-turns`` 轮数上限（0 = 不传，由 timeout 兜底）。
    """

    def __init__(self, executable: str = "claude", *, model: str | None = None,
                 timeout: float = 600.0, permission_mode: str = "acceptEdits",
                 allowed_tools: str = "Read,Edit,Write,Glob,Grep",
                 max_turns: int = 0) -> None:
        self.executable = executable
        self.model = model
        self.timeout = timeout
        self.permission_mode = permission_mode
        self.allowed_tools = allowed_tools
        self.max_turns = max_turns

    @classmethod
    def from_settings(cls, settings: Settings) -> "ClaudeCodeCLI":
        """按系统配置构建（启动点/编排器通道之一）。"""
        return cls(settings.claude_executable, model=settings.claude_model,
                   timeout=settings.claude_timeout,
                   permission_mode=settings.claude_permission_mode,
                   allowed_tools=settings.claude_allowed_tools,
                   max_turns=settings.claude_max_turns)

    # ---- 子进程 ----

    def build_argv(self, prompt: str) -> list[str]:
        """构造 argv：参数列表形式，不经 shell（Spec 05 §2.2）。

        工作区不进 argv（经 cwd 注入）；``--output-format json`` 使 stdout
        为单 JSON 结果对象（result 字段 = 最终说明，usage 字段 = 用量）。
        """
        argv = [
            self.executable, "-p", prompt,
            "--output-format", "json",
            "--permission-mode", self.permission_mode,
        ]
        if self.allowed_tools:
            argv += ["--allowedTools", self.allowed_tools]
        if self.model:
            argv += ["--model", self.model]
        if self.max_turns:
            argv += ["--max-turns", str(self.max_turns)]
        return argv

    def run(self, prompt: str, workspace: Path | str) -> CodexRunResult:
        """在工作区内执行一次修复尝试，返回最终说明/结果 JSON/用量。"""
        workspace = Path(workspace)
        argv = self.build_argv(prompt)
        try:
            proc = subprocess.run(
                argv, cwd=str(workspace), capture_output=True, text=True,
                timeout=self.timeout)
        except FileNotFoundError as exc:
            raise CodexError(
                f"未找到 claude CLI: {self.executable}"
                "（安装: npm install -g @anthropic-ai/claude-code）") from exc
        except subprocess.TimeoutExpired as exc:
            raise CodexError(f"claude -p 调用超时（{self.timeout}s）") from exc
        if proc.returncode != 0:
            raise CodexError(
                f"claude -p 退出码 {proc.returncode}: {proc.stderr.strip()[:500]}")
        result = parse_result(proc.stdout)
        if result.get("is_error"):
            raise CodexError(
                f"claude -p 执行出错（{result.get('subtype')}）: "
                f"{str(result.get('result') or '')[:300]}")
        tokens_in, tokens_out = extract_usage(result)
        return CodexRunResult(
            summary=str(result.get("result") or "").strip(),
            events=[result] if result else [],
            tokens_in=tokens_in, tokens_out=tokens_out,
            raw_log=proc.stdout[:5000])
