"""OpenAI Codex CLI 修复通道（Spec 05：codex exec 为唯一修复驱动）。

- ``CodexCLI``：headless 子进程封装。参数列表形式调用（不经 shell）、
  workspace-write 沙箱、超时杀进程、JSONL 事件流解析用量、
  ``--output-last-message`` 读最终说明；
- ``codex_preflight``：启动点静态预检（CLI 可执行 + 鉴权配置）；
- ``ScriptedCodexCLI``：测试注入桩（Spec 05 §2.5）——与 CodexCLI 同接口，
  直接改写工作区文件并返回模拟事件流；生产路径无桩、必真调 codex。

变更产物（changed_files/diff）一律由 ``pipeline.stages.common.compute_diff``
独立计算，不解析 CLI 事件流中的文件清单作准（不信任 CLI 自述）。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from autobugfixer.core.config import Settings


class CodexError(RuntimeError):
    """codex exec 调用失败（CLI 缺失 / 超时 / 非零退出 / 输出不可读）。"""


class CodexPreflightError(RuntimeError):
    """codex 启动预检失败（CLI 未安装或鉴权未配置，进程应快速退出）。"""


@dataclass
class CodexRunResult:
    """一次 codex exec 尝试的产物：最终说明 + 事件流 + 用量。"""

    summary: str = ""
    events: list[dict] = field(default_factory=list)
    tokens_in: int = 0
    tokens_out: int = 0
    raw_log: str = ""


def parse_events(stdout: str) -> list[dict]:
    """解析 ``--json`` JSONL 事件流（逐行 JSON；无法解析的行跳过，版本容错）。"""
    events: list[dict] = []
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            events.append(payload)
    return events


def _iter_usage_dicts(obj):
    """递归收集含 input/output token 计数的字典（容错不同 codex 版本的事件形状）。"""
    if isinstance(obj, dict):
        input_like = obj.get("input_tokens", obj.get("input"))
        output_like = obj.get("output_tokens", obj.get("output"))
        if (isinstance(input_like, int) and not isinstance(input_like, bool)
                and isinstance(output_like, int) and not isinstance(output_like, bool)):
            yield input_like, output_like
        for value in obj.values():
            yield from _iter_usage_dicts(value)
    elif isinstance(obj, list):
        for item in obj:
            yield from _iter_usage_dicts(item)


def extract_usage(events: list[dict]) -> tuple[int, int]:
    """从事件流提取 token 用量：取各事件计数的最大值（total_token_usage 为累计值）。"""
    tokens_in = tokens_out = 0
    for event in events:
        for i, o in _iter_usage_dicts(event):
            tokens_in = max(tokens_in, i)
            tokens_out = max(tokens_out, o)
    return tokens_in, tokens_out


def codex_preflight(settings: Settings | None = None) -> list[str]:
    """静态预检（Spec 05 §2.2 鉴权行）：CLI 可执行 + 鉴权配置（OPENAI_API_KEY 或 codex login）。"""
    from autobugfixer.core.config import get_settings

    settings = settings or get_settings()
    errors: list[str] = []
    if shutil.which(settings.codex_executable) is None:
        errors.append(
            f"未找到 codex CLI: {settings.codex_executable}"
            "（安装: npm install -g @openai/codex）")
    if not (os.environ.get("OPENAI_API_KEY")
            or (Path.home() / ".codex" / "auth.json").exists()):
        errors.append("codex 鉴权未配置：设置 OPENAI_API_KEY 或执行 codex login")
    return errors


class CodexCLI:
    """``codex exec`` headless 封装（修复主体在 Codex 内部闭环）。

    :param executable: CLI 可执行名/路径，默认 ``codex``。
    :param model: 透传 ``--model``（None 用 CLI 默认）。
    :param timeout: 单次调用超时（秒），超时杀进程。
    :param sandbox: 沙箱模式，默认 ``workspace-write``（只能写工作区，禁网）。
    """

    def __init__(self, executable: str = "codex", *, model: str | None = None,
                 timeout: float = 600.0, sandbox: str = "workspace-write") -> None:
        self.executable = executable
        self.model = model
        self.timeout = timeout
        self.sandbox = sandbox

    @classmethod
    def from_settings(cls, settings: Settings) -> "CodexCLI":
        """按系统配置构建（启动点/编排器默认通道）。"""
        return cls(settings.codex_executable, model=settings.codex_model,
                   timeout=settings.codex_timeout, sandbox=settings.codex_sandbox)

    # ---- 子进程 ----

    def build_argv(self, prompt: str, workspace: Path,
                   last_message_path: Path) -> list[str]:
        """构造 argv：参数列表形式，不经 shell（Spec 05 §2.2）。

        - ``--cd`` 限定工作目录；``-s workspace-write`` 沙箱只写工作区；
        - ``--json`` 事件流计量；``--output-last-message`` 最终说明落文件；
        - ``--skip-git-repo-check``：目录快照/空工作区不是 git 仓库时必需。
        """
        argv = [
            self.executable, "exec", prompt,
            "--cd", str(workspace),
            "-s", self.sandbox,
            "--json",
            "--output-last-message", str(last_message_path),
            "--skip-git-repo-check",
        ]
        if self.model:
            argv += ["--model", self.model]
        return argv

    def run(self, prompt: str, workspace: Path | str) -> CodexRunResult:
        """在工作区内执行一次修复尝试，返回事件流/最终说明/用量。"""
        workspace = Path(workspace)
        fd, last_message = tempfile.mkstemp(prefix="codex-last-message-", suffix=".txt")
        os.close(fd)
        argv = self.build_argv(prompt, workspace, Path(last_message))
        try:
            try:
                proc = subprocess.run(
                    argv, cwd=str(workspace), capture_output=True, text=True,
                    timeout=self.timeout)
            except FileNotFoundError as exc:
                raise CodexError(
                    f"未找到 codex CLI: {self.executable}"
                    "（安装: npm install -g @openai/codex）") from exc
            except subprocess.TimeoutExpired as exc:
                raise CodexError(f"codex exec 调用超时（{self.timeout}s）") from exc
            if proc.returncode != 0:
                raise CodexError(
                    f"codex exec 退出码 {proc.returncode}: {proc.stderr.strip()[:500]}")
            events = parse_events(proc.stdout)
            summary = ""
            try:
                summary = Path(last_message).read_text(encoding="utf-8").strip()
            except OSError:
                pass  # 最终消息文件缺失：summary 留空，用量告警不阻断
            tokens_in, tokens_out = extract_usage(events)
            return CodexRunResult(summary=summary, events=events,
                                  tokens_in=tokens_in, tokens_out=tokens_out,
                                  raw_log=proc.stdout[:5000])
        finally:
            try:
                os.unlink(last_message)
            except OSError:
                pass


class ScriptedCodexCLI:
    """测试注入桩（Spec 05 §2.5）：与 CodexCLI 同接口。

    构造参数指定要写入工作区的文件与最终说明/用量事件，模拟子进程直接
    改写工作区。这是标准测试替身，不是被移除的 Fake 修复模拟——生产路径
    无桩、必真调 codex。
    """

    def __init__(self, writes: dict[str, str] | None = None, *,
                 summary: str = "修复完成：已将 status 修正为 ok。",
                 tokens: tuple[int, int] = (48, 12),
                 events: list[dict] | None = None) -> None:
        # 注意 writes={}（显式空写入集，触发零变更出口）与 None（默认写 health）语义不同
        self.writes = {"api/health.json": '{"status": "ok"}'} if writes is None else dict(writes)
        self.summary = summary
        self.tokens = tokens
        self.events = events or [
            {"type": "token_count", "info": {"total_token_usage": {
                "input_tokens": tokens[0], "output_tokens": tokens[1]}}},
        ]
        self.calls: list[dict] = []  # 调用留痕（argv/工作区断言用）

    def run(self, prompt: str, workspace: Path | str) -> CodexRunResult:
        workspace = Path(workspace)
        for rel, content in self.writes.items():
            target = workspace / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        self.calls.append({"prompt": prompt, "workspace": str(workspace)})
        return CodexRunResult(summary=self.summary, events=list(self.events),
                              tokens_in=self.tokens[0], tokens_out=self.tokens[1],
                              raw_log="")
