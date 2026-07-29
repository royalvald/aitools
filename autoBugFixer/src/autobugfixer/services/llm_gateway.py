"""LLM Gateway（设计文档 11.3 成本治理 + 11.6 Fake 模式）。

- 所有 LLM 调用统一入口：结构化分析走 with_structured_output(Schema)，
  修复 agent 走 langchain.agents.create_agent；
- llm_mode=fake 时使用 ScriptedFakeChatModel，无需 API Key 即可跑通全流程（CI/本地开发）；
- llm_mode=anthropic 时走 langchain-anthropic；
- 每次调用计量 token 写 llm_usage，并在调用前做预算检查（超限抛 BudgetExceededError）。
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Iterator, Sequence
from datetime import datetime, timezone
from typing import Any

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import Runnable
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from ..config import Settings, get_settings
from ..models import LLMUsage

logger = logging.getLogger(__name__)


class BudgetExceededError(RuntimeError):
    """LLM 预算超限（11.3：单任务/日总量）。"""


class MeteredFixChannel:
    """修复通道计量包装：claude_code_cli 通道本身不写 llm_usage，
    用本类包一层保持预算治理口径一致（11.3）。"""

    def __init__(self, inner: Any, gateway: "LLMGateway") -> None:
        self.inner = inner
        self.gateway = gateway

    def create_fix_agent(self, tools: list[Any]) -> Any:
        """透传给被包装的修复通道。"""
        return self.inner.create_fix_agent(tools)

    def run_fix_agent(self, agent: Any, prompt: str, *,
                      task_id: int | None = None, session: Session | None = None) -> str:
        """执行修复前后做预算检查与计量记录，保持与 LangChain 通道一致的口径。"""
        self.gateway._check_budget(task_id, session)
        output = self.inner.run_fix_agent(agent, prompt, task_id=task_id, session=session)
        self.gateway._record_usage(task_id, "fixing", prompt, output, session)
        return output


def _extract_json(text: str) -> str:
    """从模型输出中提取 JSON（容忍 ```json 围栏与前后杂文本）。"""
    m = re.search(r"```(?:json)?\s*(\{.*\}|\[.*\])\s*```", text, re.DOTALL)
    if m:
        return m.group(1)
    m = re.search(r"(\{.*\}|\[.*\])", text, re.DOTALL)
    if m:
        return m.group(1)
    return text


class _StructuredRunnable(Runnable):
    """Fake 模式下的 with_structured_output 实现：调用模型并按 Schema 校验。"""

    def __init__(self, model: "ScriptedFakeChatModel", schema: type[BaseModel]) -> None:
        self._model = model
        self._schema = schema

    def invoke(self, input: Any, config: Any = None, **kwargs: Any) -> BaseModel:
        ai = self._model.invoke(input, config)
        content = ai.content if isinstance(ai.content, str) else json.dumps(ai.content)
        return self._schema.model_validate(json.loads(_extract_json(content)))


class ScriptedFakeChatModel(BaseChatModel):
    """可编排的 Fake ChatModel（Fake 模式核心，无需 API Key）。

    - responses 队列：字符串 -> 作为 content 返回；
      {"tool_calls": [{name, args}, ...]} -> 返回带工具调用的 AIMessage（供修复 agent 执行）；
    - 队列耗尽后按提示词关键字给出默认应答，保证任意顺序都能跑通；
    - 收到 ToolMessage（工具已执行）后直接输出修复说明，结束 agent 循环。
    """

    responses: list[Any] = []

    @property
    def _llm_type(self) -> str:
        return "scripted-fake-chat-model"

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> "ScriptedFakeChatModel":
        """工具绑定直接返回自身（工具调用由脚本驱动）。"""
        return self  # 工具调用由脚本驱动，无需真实绑定

    def with_structured_output(self, schema: type[BaseModel], **kwargs: Any) -> Runnable:
        """返回按 Schema 校验的结构化输出 Runnable。"""
        return _StructuredRunnable(self, schema)

    def _default_response(self, text: str) -> Any:
        """按提示词模板标题路由的兜底应答（队列耗尽时使用）。"""
        if "# Bug 修复指令" in text:
            return {"tool_calls": [{"name": "write_file", "args": {
                "path": "api/health.json", "content": '{"status": "ok"}'}}]}
        if "# Bug 完整性评估" in text:
            return {"complete": True, "missing": [], "suggestions": []}
        if "# 回归验证方案生成" in text:
            return {
                "env_requirements": "本地仿真环境",
                "steps": [
                    {"action": "call_api", "params": {"method": "GET", "path": "/health"},
                     "desc": "调用健康检查接口"},
                    {"action": "assert_response", "params": {"json_path": "status", "expect": "ok"},
                     "desc": "断言 status 为 ok"},
                ],
                "expected_results": ["status 为 ok"],
                "function_points": ["健康检查"],
                "regression_scope": "接口回归",
            }
        if "# 综合难度评分" in text:
            return {"fix_difficulty": 20, "verify_difficulty": 15, "change_scale": 10,
                    "rationale": "fake 模式默认低难度"}
        if "# 失败分析" in text:
            return {"condition_desc": "fake 模式默认不适用场景：超出自动修复能力边界",
                    "reason": "多次重试验证仍未通过（fake 应答）",
                    "discussion_topic": "请评审失败原因并决定人工接手方案"}
        return "{}"

    def _next_response(self, messages: list[BaseMessage]) -> Any:
        if self.responses:
            return self.responses.pop(0)
        text = "\n".join(str(m.content) for m in messages[-3:])
        return self._default_response(text)

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        # 工具已执行过 -> 输出修复说明，终止 agent 工具循环
        if any(isinstance(m, ToolMessage) for m in messages):
            return ChatResult(generations=[ChatGeneration(
                message=AIMessage(content="修复完成：已将 status 修正为 ok。"))])
        canned = self._next_response(messages)
        if isinstance(canned, dict) and "tool_calls" in canned:
            tool_calls = [
                {"name": tc["name"], "args": tc["args"], "id": f"call_{i}", "type": "tool_call"}
                for i, tc in enumerate(canned["tool_calls"])
            ]
            return ChatResult(generations=[ChatGeneration(
                message=AIMessage(content="", tool_calls=tool_calls))])
        content = canned if isinstance(canned, str) else json.dumps(canned, ensure_ascii=False)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=content))])


class LLMGateway:
    """统一 LLM 入口：结构化分析 + 修复 agent + 计量 + 预算。"""

    def __init__(
        self,
        settings: Settings | None = None,
        session_factory: sessionmaker[Session] | None = None,
        fake_responses: list[Any] | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.session_factory = session_factory
        self.fake_responses = list(fake_responses or [])

    # ---- 模型 ----

    def _chat_model(self) -> BaseChatModel:
        """按 llm_mode 构造聊天模型：anthropic 走真实 API，否则用脚本化 Fake 模型。"""
        if self.settings.llm_mode == "anthropic":
            from langchain_anthropic import ChatAnthropic

            return ChatAnthropic(
                model=self.settings.anthropic_model,
                api_key=self.settings.anthropic_api_key,
                max_tokens=4096,
            )
        # 共享可变队列：构造后赋值以保留引用（pydantic 初始化可能拷贝列表）
        model = ScriptedFakeChatModel()
        model.responses = self.fake_responses
        return model

    # ---- 结构化分析（完整性评估 / 方案生成 / 评分） ----

    def analyze(self, prompt: str, schema: type[BaseModel], *,
                task_id: int | None, stage: str, session: Session | None = None) -> BaseModel:
        """结构化分析调用：with_structured_output(Schema)，校验失败按配置重试。"""
        self._check_budget(task_id, session)
        model = self._chat_model()
        structured = model.with_structured_output(schema)
        last_error: Exception | None = None
        for _ in range(self.settings.stage_max_retry + 1):
            try:
                result = structured.invoke(prompt)
                self._record_usage(task_id, stage, prompt, json.dumps(
                    result.model_dump(), ensure_ascii=False), session)
                return result
            except Exception as exc:  # JSON/Schema 校验失败重试
                last_error = exc
                logger.warning("LLM 结构化输出校验失败，重试: %s", exc)
        raise ValueError(f"LLM 结构化输出多次校验失败: {last_error}")

    # ---- 修复 agent（create_agent + 工具） ----

    def create_fix_agent(self, tools: list[Any]) -> Any:
        """用当前模型 + 工具集组装 LangChain 修复 agent。"""
        from langchain.agents import create_agent

        return create_agent(self._chat_model(), tools=tools)

    def run_fix_agent(self, agent: Any, prompt: str, *,
                      task_id: int | None, session: Session | None = None) -> str:
        """执行修复 agent 并计量；返回最终消息内容。"""
        self._check_budget(task_id, session)
        result = agent.invoke({"messages": [{"role": "user", "content": prompt}]})
        final = result["messages"][-1]
        content = final.content if isinstance(final.content, str) else str(final.content)
        total_in = sum(len(str(m.content)) for m in result["messages"]) // 4
        self._record_usage(task_id, "fixing", prompt, content, session, tokens_in=max(total_in, 1))
        return content

    # ---- 计量与预算（11.3） ----

    @staticmethod
    def _est_tokens(text: str) -> int:
        return max(len(text) // 4, 1)

    def _check_budget(self, task_id: int | None, session: Session | None) -> None:
        """调用前预算检查：累计 token 超单任务/日总量阈值则抛 BudgetExceededError。"""
        if self.session_factory is None:
            return
        own = session is None
        s = session or self.session_factory()
        try:
            if task_id is not None:
                used = s.scalar(select(func.coalesce(func.sum(
                    LLMUsage.tokens_in + LLMUsage.tokens_out), 0)).where(
                    LLMUsage.task_id == task_id))
                if (used or 0) >= self.settings.task_token_budget:
                    raise BudgetExceededError(
                        f"任务 {task_id} token 预算超限: {used} >= {self.settings.task_token_budget}")
            today = datetime.now(timezone.utc).date()
            daily = s.scalar(select(func.coalesce(func.sum(
                LLMUsage.tokens_in + LLMUsage.tokens_out), 0)).where(
                func.date(LLMUsage.created_at) == today.isoformat()))
            if (daily or 0) >= self.settings.daily_token_budget:
                raise BudgetExceededError(f"日 token 预算超限: {daily}")
        finally:
            if own:
                s.close()

    def _record_usage(self, task_id: int | None, stage: str, prompt: str, output: str,
                      session: Session | None, tokens_in: int | None = None) -> None:
        """写入一条 llm_usage 计量记录（估算 token）；无 session_factory 时跳过。"""
        if self.session_factory is None:
            return
        own = session is None
        s = session or self.session_factory()
        try:
            usage = LLMUsage(
                task_id=task_id, stage=stage,
                model=f"{self.settings.llm_mode}:{self.settings.anthropic_model}",
                tokens_in=tokens_in or self._est_tokens(prompt),
                tokens_out=self._est_tokens(output),
                cost_est=0.0,  # fake 模式成本为 0；anthropic 模式可按价目表估算
            )
            s.add(usage)
            if own:
                s.commit()
            else:
                s.flush()
        finally:
            if own:
                s.close()
