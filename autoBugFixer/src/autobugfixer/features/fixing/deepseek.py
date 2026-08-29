"""DeepSeek 修复通道（Spec 05 扩展：与 codex exec 并列的第二修复驱动）。

- ``DeepSeekFixer``：与 ``CodexCLI`` 同接口（``run(prompt, workspace) ->
  CodexRunResult``，失败抛 ``CodexError``），经 DeepSeek OpenAI 兼容
  chat completions + function calling 驱动修复智能体回路；
- 工具集：list_files / read_file / write_file / run_command / finish；
  文件工具做路径包含校验（拒绝绝对路径与 ``..`` 逃逸出工作区）；
  run_command 以工作区为 cwd 子进程执行（超时杀进程）；
- 停止条件：finish 调用 / 无工具调用的最终答复 / 步数上限 / API 错误；
- 变更产物仍由 ``compute_diff`` 独立计算，不信任模型自述（与 codex 通道一致）；
- ``transport`` 注入点：测试注入脚本化应答序列，生产路径走 httpx 直连。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import httpx

from autobugfixer.common.core.config import Settings
from autobugfixer.features.fixing.codex import CodexError, CodexRunResult

# 单工具输出的回传上限（字符）：日志/大文件读出截断，防止上下文爆炸
_TOOL_OUTPUT_LIMIT = 4000
# run_command 单条命令超时（秒）
_COMMAND_TIMEOUT = 60.0

SYSTEM_PROMPT = """你是自动化 Bug 修复系统的执行引擎，在指定工作区内完成修复任务。
工作区: {workspace}

规则：
- 所有文件操作限定在工作区内，路径一律使用相对路径；
- run_command 以工作区为工作目录执行 shell 命令（无额外沙箱，禁止破坏性命令）；
- 修复完成后必须调用 finish 工具提交修复说明（根因/改动/自验/风险四段）；
- 每轮只做必要的工具调用，避免无效往返。
"""

# OpenAI function calling 工具词表（修复智能体的全部能力边界）
TOOLS: list[dict] = [
    {"type": "function", "function": {
        "name": "list_files", "description": "列出工作区内文件（相对路径）",
        "parameters": {"type": "object",
                       "properties": {"path": {"type": "string", "description": "相对目录，默认 ."}},
                       "required": []}}},
    {"type": "function", "function": {
        "name": "read_file", "description": "读取工作区内文本文件",
        "parameters": {"type": "object",
                       "properties": {"path": {"type": "string", "description": "工作区内相对路径"}},
                       "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "write_file", "description": "写入（覆盖）工作区内文本文件，自动创建父目录",
        "parameters": {"type": "object",
                       "properties": {"path": {"type": "string", "description": "工作区内相对路径"},
                                      "content": {"type": "string", "description": "完整文件内容"}},
                       "required": ["path", "content"]}}},
    {"type": "function", "function": {
        "name": "run_command", "description": "在工作区目录执行 shell 命令并返回输出",
        "parameters": {"type": "object",
                       "properties": {"command": {"type": "string", "description": "shell 命令"}},
                       "required": ["command"]}}},
    {"type": "function", "function": {
        "name": "finish", "description": "修复完成，提交最终修复说明",
        "parameters": {"type": "object",
                       "properties": {"summary": {"type": "string", "description": "修复说明全文"}},
                       "required": ["summary"]}}},
]


class DeepSeekFixer:
    """DeepSeek 修复驱动（chat completions + function calling 智能体回路）。

    :param api_key: DeepSeek API Key。
    :param base_url: OpenAI 兼容基础地址（默认官方 https://api.deepseek.com）。
    :param model: 修复用模型（建议 deepseek-chat）。
    :param timeout: 单次 API 请求超时（秒）。
    :param max_steps: 智能体回路步数上限（每轮 = 一次 API 调用及其工具执行）。
    :param transport: 请求注入点（测试用）：``transport(messages) -> 应答 dict``；
      缺省走 httpx 直连 chat completions。
    """

    def __init__(self, *, api_key: str, base_url: str = "https://api.deepseek.com",
                 model: str = "deepseek-chat", timeout: float = 120.0,
                 max_steps: int = 24, transport=None) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.max_steps = max_steps
        self._transport = transport

    @classmethod
    def from_settings(cls, settings: Settings) -> "DeepSeekFixer":
        """按系统配置构建（调度器/编排器默认通道之一）。"""
        return cls(
            api_key=settings.deepseek_api_key or "",
            base_url=settings.deepseek_base_url,
            model=settings.deepseek_fix_model or settings.deepseek_model,
            timeout=settings.deepseek_timeout,
            max_steps=settings.deepseek_fix_max_steps,
        )

    # ---- 智能体回路 ----

    def run(self, prompt: str, workspace: Path | str) -> CodexRunResult:
        """在工作区内执行一次修复回路，返回最终说明/事件流/用量（与 CodexCLI 同契约）。"""
        workspace = Path(workspace).resolve()
        messages: list[dict] = [
            {"role": "system", "content": SYSTEM_PROMPT.format(workspace=workspace)},
            {"role": "user", "content": prompt},
        ]
        tokens_in = tokens_out = 0
        events: list[dict] = []
        raw_parts: list[str] = []

        for step in range(1, self.max_steps + 1):
            try:
                data = self._post(messages)
            except CodexError:
                raise
            except Exception as exc:  # 传输层/协议异常统一按通道失败处理
                raise CodexError(f"DeepSeek API 调用失败: {exc}") from exc
            usage = data.get("usage") or {}
            tokens_in += int(usage.get("prompt_tokens") or 0)
            tokens_out += int(usage.get("completion_tokens") or 0)

            choice = (data.get("choices") or [{}])[0]
            message = choice.get("message") or {}
            calls = message.get("tool_calls") or []
            call_names = [c.get("function", {}).get("name", "") for c in calls]
            events.append({"type": "step", "step": step, "tool_calls": call_names,
                           "usage": {"input_tokens": usage.get("prompt_tokens", 0),
                                     "output_tokens": usage.get("completion_tokens", 0)}})
            raw_parts.append(json.dumps(
                {"step": step, "message": _slim_message(message)},
                ensure_ascii=False))

            if not calls:  # 无工具调用的最终答复：视为修复说明收尾
                return CodexRunResult(
                    summary=(message.get("content") or "").strip(), events=events,
                    tokens_in=tokens_in, tokens_out=tokens_out,
                    raw_log="\n".join(raw_parts)[:5000])

            messages.append({"role": "assistant",
                             "content": message.get("content") or "",
                             "tool_calls": calls})
            for call in calls:
                name = (call.get("function") or {}).get("name", "")
                args = _parse_args((call.get("function") or {}).get("arguments"))
                result = self._dispatch(name, args, workspace)
                raw_parts.append(json.dumps(
                    {"step": step, "tool": name, "result": _slim(result)},
                    ensure_ascii=False))
                messages.append({
                    "role": "tool", "tool_call_id": call.get("id", ""),
                    "content": json.dumps(_slim(result), ensure_ascii=False)})
                if name == "finish":  # 修复说明已提交，回路结束
                    return CodexRunResult(
                        summary=str(result.get("summary", "")), events=events,
                        tokens_in=tokens_in, tokens_out=tokens_out,
                        raw_log="\n".join(raw_parts)[:5000])

        raise CodexError(f"DeepSeek 修复回路超过步数上限（{self.max_steps} 步）")

    # ---- API ----

    def _post(self, messages: list[dict]) -> dict:
        """一次 chat completions 调用；HTTP/协议错误统一抛 CodexError。"""
        if self._transport is not None:  # 测试注入点
            return self._transport(messages)
        payload = {"model": self.model, "messages": messages,
                   "tools": TOOLS, "tool_choice": "auto"}
        try:
            resp = httpx.post(
                f"{self.base_url}/chat/completions", json=payload,
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=self.timeout)
        except httpx.HTTPError as exc:
            raise CodexError(f"DeepSeek API 请求失败: {exc}") from exc
        if resp.status_code != 200:
            raise CodexError(
                f"DeepSeek API 状态码 {resp.status_code}: {resp.text[:300]}")
        return resp.json()

    # ---- 工具执行（全部限定在工作区内） ----

    def _dispatch(self, name: str, args: dict, workspace: Path) -> dict:
        """执行单个工具调用；异常转错误应答回传模型（由模型自行纠正），不中断回路。"""
        try:
            if name == "list_files":
                return {"ok": True, "files": self._list_files(args.get("path") or ".",
                                                              workspace)}
            if name == "read_file":
                return {"ok": True, "content": self._read_file(args["path"], workspace)}
            if name == "write_file":
                self._write_file(args["path"], args.get("content", ""), workspace)
                return {"ok": True}
            if name == "run_command":
                return self._run_command(args.get("command", ""), workspace)
            if name == "finish":
                return {"ok": True, "summary": str(args.get("summary", ""))}
            return {"ok": False, "error": f"未知工具: {name}"}
        except KeyError as exc:
            return {"ok": False, "error": f"缺少参数: {exc}"}
        except Exception as exc:  # 工具失败不炸回路：错误信息回传给模型
            return {"ok": False, "error": str(exc)}

    def _resolve(self, rel: str, workspace: Path) -> Path:
        """路径包含校验：解析后必须仍位于工作区内（防绝对路径与 .. 逃逸）。"""
        target = Path(rel)
        target = target.resolve() if target.is_absolute() else (workspace / target).resolve()
        if not str(target).startswith(str(workspace)):
            raise PermissionError(f"路径越出工作区: {rel}")
        return target

    def _list_files(self, rel: str, workspace: Path) -> list[str]:
        root = self._resolve(rel, workspace)
        if not root.is_dir():
            raise NotADirectoryError(f"目录不存在: {rel}")
        return sorted(str(p.relative_to(workspace))
                      for p in root.rglob("*") if p.is_file())[:200]

    def _read_file(self, rel: str, workspace: Path) -> str:
        target = self._resolve(rel, workspace)
        if not target.is_file():
            raise FileNotFoundError(f"文件不存在: {rel}")
        return target.read_text(encoding="utf-8", errors="replace")[:_TOOL_OUTPUT_LIMIT]

    def _write_file(self, rel: str, content: str, workspace: Path) -> None:
        target = self._resolve(rel, workspace)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def _run_command(self, command: str, workspace: Path) -> dict:
        proc = subprocess.run(command, shell=True, cwd=str(workspace),
                              capture_output=True, text=True,
                              timeout=_COMMAND_TIMEOUT)
        return {"ok": proc.returncode == 0, "returncode": proc.returncode,
                "stdout": proc.stdout.strip()[:_TOOL_OUTPUT_LIMIT],
                "stderr": proc.stderr.strip()[:_TOOL_OUTPUT_LIMIT]}


def _parse_args(raw) -> dict:
    """解析工具调用 arguments（JSON 字符串；空/坏参按空参处理，由工具侧报缺参）。"""
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _slim(result: dict) -> dict:
    """工具应答瘦身：超长文本字段截断后再回传模型/日志。"""
    return {k: (v[:500] + f"…（截断，共 {len(v)} 字符）" if isinstance(v, str) and len(v) > 500 else v)
            for k, v in result.items()}


def _slim_message(message: dict) -> dict:
    """事件流里的消息瘦身：只留角色/内容摘要/工具调用名与参数摘要。"""
    return {"role": message.get("role"),
            "content": (message.get("content") or "")[:300],
            "tool_calls": [
                {"name": (c.get("function") or {}).get("name"),
                 "arguments": str((c.get("function") or {}).get("arguments"))[:300]}
                for c in (message.get("tool_calls") or [])]}
