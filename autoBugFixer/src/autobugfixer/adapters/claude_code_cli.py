"""Claude Code headless CLI 修复通道（设计文档 4.2.1 / 6.2）。

两层接口：

- ``ClaudeCodeCLI``：ClaudeCodeAdapter 契约（``fix`` / ``analyze``），直接封装
  ``claude -p "<prompt>" --output-format json`` 子进程；
- ``ClaudeCodeFixChannel``：与现有 LangChain 修复通道（LLMGateway 的
  ``create_fix_agent`` / ``run_fix_agent``）同签名、可互换——pipeline fixing
  stage 无需改动即可把 ``ctx.llm`` 换成本通道。

约束：子进程一律参数列表形式调用（无 shell 拼接，防注入）、带超时控制；
CLI 不存在 / 超时 / 非零退出 / 输出不可解析均抛 ``ClaudeCodeError``。
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel, Field


class FixResult(BaseModel):
    """修复结果（设计文档 4.2.1：changed_files[] / diff / summary / raw_log）。"""

    changed_files: list[str] = Field(default_factory=list)
    diff: str = ""
    summary: str = ""
    raw_log: str = ""


class ClaudeCodeAdapter(Protocol):
    def fix(self, workspace: str | Path, prompt: str) -> FixResult: ...
    def analyze(self, prompt: str, schema: type, *, workspace: str | Path | None = None) -> Any: ...


class ClaudeCodeError(RuntimeError):
    """Claude Code CLI 调用失败（缺失 / 超时 / 非零退出 / 输出不可解析）。"""


class ClaudeCodeCLI:
    """``claude -p`` headless 封装。

    :param executable: CLI 可执行名/路径，默认 ``claude``。
    :param timeout: 单次调用超时（秒）。
    :param model / max_turns: 透传 ``--model`` / ``--max-turns``。
    :param skip_permissions: headless 无人值守需跳过交互授权
        （``--dangerously-skip-permissions``），生产应配合容器/目录收敛使用。
    :param extra_args: 追加透传的 CLI 参数（列表形式）。
    """

    def __init__(
        self,
        executable: str = "claude",
        *,
        timeout: float = 600.0,
        model: str | None = None,
        max_turns: int | None = None,
        skip_permissions: bool = True,
        extra_args: list[str] | None = None,
    ) -> None:
        self.executable = executable
        self.timeout = timeout
        self.model = model
        self.max_turns = max_turns
        self.skip_permissions = skip_permissions
        self.extra_args = list(extra_args or [])

    # ---- ClaudeCodeAdapter 契约 ----

    def fix(self, workspace: str | Path, prompt: str) -> FixResult:
        workspace = Path(workspace)
        proc = self._run(self._build_args(prompt), cwd=str(workspace))
        payload = _parse_payload(proc.stdout)
        if payload.get("is_error"):
            raise ClaudeCodeError(f"Claude Code 返回错误: {str(payload.get('result'))[:500]}")
        changed_files, diff = _workspace_changes(workspace)
        return FixResult(
            changed_files=changed_files,
            diff=diff,
            summary=str(payload.get("result") or "").strip(),
            raw_log=proc.stdout,
        )

    def analyze(self, prompt: str, schema: type, *, workspace: str | Path | None = None) -> Any:
        """结构化分析：要求模型仅输出 JSON，提取后按 Schema 校验。"""
        full = prompt + "\n\n仅输出符合目标 Schema 的 JSON，不要输出任何其他文字。"
        proc = self._run(self._build_args(full), cwd=str(workspace) if workspace else None)
        payload = _parse_payload(proc.stdout)
        text = str(payload.get("result") or proc.stdout)
        return schema.model_validate(json.loads(_extract_json(text)))

    # ---- 子进程 ----

    def _build_args(self, prompt: str) -> list[str]:
        args = ["-p", prompt, "--output-format", "json"]
        if self.model:
            args += ["--model", self.model]
        if self.max_turns:
            args += ["--max-turns", str(self.max_turns)]
        if self.skip_permissions:
            args.append("--dangerously-skip-permissions")
        return args + self.extra_args

    def _run(self, args: list[str], cwd: str | None) -> subprocess.CompletedProcess:
        cmd = [self.executable, *args]  # 参数列表形式，不经 shell
        try:
            proc = subprocess.run(
                cmd, cwd=cwd, capture_output=True, text=True, timeout=self.timeout
            )
        except FileNotFoundError as exc:
            raise ClaudeCodeError(
                f"未找到 Claude Code CLI: {self.executable}"
                "（安装: npm install -g @anthropic-ai/claude-code）"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise ClaudeCodeError(
                f"Claude Code CLI 调用超时（{self.timeout}s）"
            ) from exc
        if proc.returncode != 0:
            raise ClaudeCodeError(
                f"Claude Code CLI 退出码 {proc.returncode}: {proc.stderr.strip()[:500]}"
            )
        return proc


class _CliAgent:
    """``create_fix_agent`` 返回的句柄：携带 CLI 与工作区，供 run_fix_agent 执行。"""

    def __init__(self, cli: ClaudeCodeCLI, workspace: Path | None) -> None:
        self.cli = cli
        self.workspace = workspace


class ClaudeCodeFixChannel:
    """与 LLMGateway 修复通道同签名（create_fix_agent / run_fix_agent），可互换。

    工作区解析顺序：构造时显式传入的 ``workspace`` > 从
    ``make_workspace_tools`` 生成的工具闭包中提取（约定式，见
    ``_workspace_from_tools``）。都无法确定时 run_fix_agent 抛错。

    注意：本通道不写 llm_usage 计量；预算治理需要时请在外层包裹或扩展。
    """

    def __init__(
        self,
        cli: ClaudeCodeCLI | None = None,
        *,
        workspace: str | Path | None = None,
        **cli_kwargs,
    ) -> None:
        self._cli = cli or ClaudeCodeCLI(**cli_kwargs)
        self._workspace = Path(workspace) if workspace is not None else None

    def create_fix_agent(self, tools: list[Any]) -> _CliAgent:
        return _CliAgent(self._cli, self._workspace or _workspace_from_tools(tools))

    def run_fix_agent(
        self, agent: _CliAgent, prompt: str, *, task_id: int | None = None, session=None
    ) -> str:
        if agent.workspace is None:
            raise ClaudeCodeError(
                "无法确定 Claude Code 工作区：请构造 "
                "ClaudeCodeFixChannel(workspace=...) 显式指定"
            )
        result = agent.cli.fix(agent.workspace, prompt)
        return result.summary


def _workspace_from_tools(tools: list[Any]) -> Path | None:
    """从 make_workspace_tools 的工具闭包中提取工作区 Path（约定式解析）。"""
    for tool in tools or []:
        func = getattr(tool, "func", None)
        for cell in getattr(func, "__closure__", None) or []:
            try:
                value = cell.cell_contents
            except ValueError:
                continue
            if isinstance(value, Path):
                return value
    return None


def _workspace_changes(workspace: Path) -> tuple[list[str], str]:
    """计算变更：优先 pipeline 的 .baseline 快照约定，其次 git diff，否则为空。"""
    if (workspace / ".baseline").is_dir():
        from ..pipeline.stages.common import compute_diff  # 惰性，避免 adapters->pipeline 环

        return compute_diff(workspace)
    if (workspace / ".git").exists():
        try:
            names = subprocess.run(
                ["git", "-C", str(workspace), "diff", "--name-only", "HEAD"],
                capture_output=True, text=True, timeout=30,
            )
            untracked = subprocess.run(
                ["git", "-C", str(workspace), "ls-files", "--others", "--exclude-standard"],
                capture_output=True, text=True, timeout=30,
            )
            diff = subprocess.run(
                ["git", "-C", str(workspace), "diff", "HEAD"],
                capture_output=True, text=True, timeout=30,
            )
            if names.returncode == 0:
                changed = [l.strip() for l in names.stdout.splitlines() if l.strip()]
                if untracked.returncode == 0:
                    changed += [l.strip() for l in untracked.stdout.splitlines() if l.strip()]
                return changed, diff.stdout
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
    return [], ""


def _parse_payload(stdout: str) -> dict:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise ClaudeCodeError(
            f"无法解析 Claude Code JSON 输出: {stdout[:300]}"
        ) from exc
    if not isinstance(payload, dict):
        raise ClaudeCodeError(f"Claude Code 输出非 JSON 对象: {stdout[:300]}")
    return payload


def _extract_json(text: str) -> str:
    """从模型输出中提取 JSON（容忍 ```json 围栏与前后杂文本）。"""
    m = re.search(r"```(?:json)?\s*(\{.*\}|\[.*\])\s*```", text, re.DOTALL)
    if m:
        return m.group(1)
    m = re.search(r"(\{.*\}|\[.*\])", text, re.DOTALL)
    if m:
        return m.group(1)
    return text
