"""LLM Gateway（设计文档 11.3 成本治理 + 11.6 Fake 模式）。

- 分析类 LLM 调用统一入口：结构化分析走 with_structured_output(Schema)；
  修复驱动已统一为 codex exec 子进程（Spec 05），其事件流用量经本网关计量；
- llm_mode=fake 时使用 ScriptedFakeChatModel，无需 API Key 即可跑通全流程（CI/本地开发）；
- llm_mode=anthropic 时走 langchain-anthropic；
- 每次调用计量 token 写 llm_usage，并在调用前做预算检查（超限抛 BudgetExceededError）。
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import Runnable
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from autobugfixer.common.core.config import Settings, get_settings
from autobugfixer.common.core.models import LLMUsage

logger = logging.getLogger(__name__)


class BudgetExceededError(RuntimeError):
    """LLM 预算超限（11.3：单任务/日总量）。"""


class LLMPreflightError(RuntimeError):
    """LLM 启动预检失败（静态配置错误，进程应快速退出而非带病运行）。"""


@dataclass
class PreflightReport:
    """启动预检结果：静态校验错误 + 连通探测错误（Spec 02 B0）。"""

    mode: str
    static_errors: list[str] = field(default_factory=list)
    probe_error: str | None = None

    @property
    def static_ok(self) -> bool:
        return not self.static_errors

    @property
    def ok(self) -> bool:
        return self.static_ok and self.probe_error is None

    def summary(self) -> str:
        """拼接全部错误信息（供日志/报错文案）。"""
        parts = list(self.static_errors)
        if self.probe_error:
            parts.append(f"连通探测失败: {self.probe_error}")
        return "; ".join(parts)


def _extract_json(text: str) -> str:
    """从模型输出中提取 JSON（容忍 ```json 围栏与前后杂文本）。"""
    m = re.search(r"```(?:json)?\s*(\{.*\}|\[.*\])\s*```", text, re.DOTALL)
    if m:
        return m.group(1)
    m = re.search(r"(\{.*\}|\[.*\])", text, re.DOTALL)
    if m:
        return m.group(1)
    return text


def _error_summary(exc: Exception, limit: int = 600) -> str:
    """压缩校验错误为可注入 prompt 的摘要（pydantic 逐字段错误优先，总量截断）。"""
    errors = getattr(exc, "errors", None)
    if callable(errors):
        parts = []
        for e in errors()[:8]:
            loc = ".".join(str(x) for x in e.get("loc", ()))
            parts.append(f"{loc}: {e.get('msg', e)}")
        text = "; ".join(parts) or str(exc)
    else:
        text = str(exc)
    return text[:limit]


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

    - responses 队列：字符串/字典 -> 按内容返回（分析类结构化输出用）；
    - 队列耗尽后按提示词关键字给出默认应答，保证任意顺序都能跑通；
    - 修复驱动的 Fake 兜底已随 langchain 修复通道一并移除（Spec 05 §6），
      修复链路由 CodexCLI/ScriptedCodexCLI 承接。
    """

    responses: list[Any] = []

    @property
    def _llm_type(self) -> str:
        return "scripted-fake-chat-model"

    def with_structured_output(self, schema: type[BaseModel], **kwargs: Any) -> Runnable:
        """返回按 Schema 校验的结构化输出 Runnable。"""
        return _StructuredRunnable(self, schema)

    def _default_response(self, text: str) -> Any:
        """按提示词模板标题路由的兜底应答（队列耗尽时使用）。"""
        if "# Bug 完整性评估" in text:
            return {"complete": True, "missing": [], "suggestions": []}
        if "# 仓库全局画像分析" in text:
            # 全局仓库事实画像（Spec 02 §9 v2）：无 Bug 上下文，挂 repo 表全局复用
            return {"summary": "fake 画像：健康检查服务仓库",
                    "tech_stack": ["python"], "key_dirs": ["api"],
                    "entry_points": []}
        if "# 回归验证方案生成" in text:
            # 四段式五步方案（Spec 03 §9.5：Fake 应答同步升级，保证新校验下可落库）；
            # target_repos 默认零选定（Spec 02 §9 v3）：声明链接仍强制保留，
            # 未声明 Bug 走 planning 的仓库补充介入
            return {
                "target_repos": [],
                "env_requirements": "本地仿真环境",
                "steps": [
                    {"action": "input", "params": {"selector": "#env", "value": "v1.0.0"},
                     "desc": "确认环境版本"},
                    {"action": "call_api", "params": {"method": "GET", "path": "/health"},
                     "desc": "调用健康检查接口"},
                    {"action": "assert_response",
                     "params": {"json_path": "status", "expect": "ok"},
                     "desc": "断言 status 为 ok"},
                    {"action": "click", "params": {"selector": "#recheck"},
                     "desc": "复测触发健康检查"},
                    {"action": "assert_response",
                     "params": {"json_path": "status", "expect": "ok"},
                     "desc": "复测断言 status 为 ok"},
                ],
                "expected_results": ["status 为 ok"],
                "function_points": ["健康检查"],
                "regression_scope": "接口回归",
                "fix_approach": {
                    "locate_hints": ["/health 接口返回 status=fail"],
                    "change_files": ["api/health.json"],
                    "strategy": "将健康检查返回的 status 修正为 ok",
                },
            }
        if "# 代码实证" in text:
            # 评分 v2 复杂类型第二次调用（Spec 04 §8.6）
            return {"triggered": True, "suspected_files": ["api/health.py"],
                    "change_scale_estimate": "单文件小改动（fake 应答）"}
        if "# 综合难度评分" in text and "scoring v2" in text:
            # 评分 v2 判定表单（Spec 04 §8.5：只判定，不打分）
            return {"bug_type": "single_logic", "type_evidence": "fake 判定：单函数内逻辑错误",
                    "factors_hit": ["repro_executable"],
                    "factor_evidence": {"repro_executable": "复现步骤给出具体操作序列"},
                    "locate_signals": {"has_stack": False, "has_location_desc": True},
                    "code_evidence": {"triggered": False}}
        if "# 综合难度评分" in text:
            return {"fix_difficulty": 20, "verify_difficulty": 15, "change_scale": 10,
                    "rationale": "fake 模式默认低难度"}
        if "# 失败分析" in text:
            return {"condition_desc": "fake 模式默认不适用场景：超出自动修复能力边界",
                    "reason": "多次重试验证仍未通过（fake 应答）",
                    "discussion_topic": "请评审失败原因并决定人工接手方案"}
        if "# 修复经验归因" in text:
            # 成功分支经验归因（Spec 08 §7）
            return {"category": "接口类",
                    "root_cause_pattern": "fake 归因：status 字段在校验分支被误判为 fail"}
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
        canned = self._next_response(messages)
        content = canned if isinstance(canned, str) else json.dumps(canned, ensure_ascii=False)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=content))])


class LLMGateway:
    """统一 LLM 入口：结构化分析 + 计量 + 预算（修复通道的预算/计量入口见公开方法）。"""

    def __init__(
        self,
        settings: Settings | None = None,
        session_factory: sessionmaker[Session] | None = None,
        fake_responses: list[Any] | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.session_factory = session_factory
        self.fake_responses = list(fake_responses or [])

    # ---- 启动预检（Spec 02 B0） ----

    def preflight(self, probe: bool = True) -> PreflightReport:
        """启动点预检：静态校验配置 + 可选连通探测（仅 anthropic 模式联网）。

        fake 模式零依赖直接通过；探测调用不关联任务、不计预算（B0-3/B0-4）。
        """
        report = PreflightReport(mode=self.settings.llm_mode)
        mode = self.settings.llm_mode
        if mode not in ("fake", "anthropic"):
            report.static_errors.append(f"llm_mode 非法: {mode!r}（可选 fake / anthropic）")
            return report
        if mode == "anthropic":
            if not self.settings.anthropic_api_key:
                report.static_errors.append(
                    "llm_mode=anthropic 但未配置 ANTHROPIC_API_KEY")
            if not self.settings.anthropic_model:
                report.static_errors.append("llm_mode=anthropic 但未配置模型名")
        if probe and report.static_ok and mode == "anthropic":
            try:
                self._probe_model().invoke("ping")
            except Exception as exc:  # 网络/认证/模型名错误统一落到探测错误
                report.probe_error = f"{type(exc).__name__}: {exc}"
        return report

    def _probe_model(self) -> BaseChatModel:
        """探测专用模型：最小 token + 短超时，失败快速返回（测试可替换）。"""
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(
            model=self.settings.anthropic_model,
            api_key=self.settings.anthropic_api_key,
            max_tokens=1,
            timeout=10,
        )

    # ---- 模型 ----

    def _chat_model(self, max_tokens: int | None = None) -> BaseChatModel:
        """按 llm_mode 构造聊天模型：anthropic 走真实 API，否则用脚本化 Fake 模型。"""
        if self.settings.llm_mode == "anthropic":
            from langchain_anthropic import ChatAnthropic

            return ChatAnthropic(
                model=self.settings.anthropic_model,
                api_key=self.settings.anthropic_api_key,
                max_tokens=max_tokens or self.settings.llm_max_tokens,
            )
        # 共享可变队列：构造后赋值以保留引用（pydantic 初始化可能拷贝列表）
        model = ScriptedFakeChatModel()
        model.responses = self.fake_responses
        return model

    # ---- 结构化分析（完整性评估 / 方案生成 / 评分） ----

    def analyze(self, prompt: str, schema: type[BaseModel], *,
                task_id: int | None, stage: str, session: Session | None = None,
                system: str | None = None, max_tokens: int | None = None) -> BaseModel:
        """结构化分析调用：with_structured_output(Schema)，校验失败按配置重试。

        - system：模板 system 段（角色/规则），进入 system 通道（提示词工程约定：
          规则与外部数据分离，降低数据内容覆盖指令的风险）；缺省整体走 user；
        - 重试不是原样重发：附上一次的结构校验错误摘要，让模型知道改什么
          （确定性校验失败原样重发大概率得到同样答案）；
        - max_tokens：输出上限覆盖（如 planning 8192），缺省用配置。
        """
        self._check_budget(task_id, session)
        model = self._chat_model(max_tokens)
        structured = model.with_structured_output(schema)
        messages: Any = prompt
        if system:
            messages = [SystemMessage(content=system), HumanMessage(content=prompt)]
        attempt_prompt = prompt
        last_error: Exception | None = None
        for attempt in range(self.settings.stage_max_retry + 1):
            try:
                result = structured.invoke(messages)
                self._record_usage(task_id, stage, attempt_prompt, json.dumps(
                    result.model_dump(), ensure_ascii=False), session)
                return result
            except Exception as exc:  # JSON/Schema 校验失败：附错误反馈后重试
                last_error = exc
                if attempt < self.settings.stage_max_retry:
                    feedback = (f"\n\n---\n（第 {attempt + 1} 次输出未通过结构校验，错误："
                                f"{_error_summary(exc)}。请严格按上方要求的 JSON 格式"
                                f"重新输出，仅输出 JSON 本体，不要附加说明。）")
                    attempt_prompt = prompt + feedback
                    messages = ([SystemMessage(content=system), HumanMessage(content=attempt_prompt)]
                                if system else attempt_prompt)
                    logger.warning("LLM 结构化输出校验失败，附错误反馈重试: %s", exc)
        raise ValueError(f"LLM 结构化输出多次校验失败: {last_error}")

    # ---- 修复通道的预算与计量入口（Spec 05：codex 事件流用量统一走本网关） ----

    def check_budget(self, task_id: int | None, session: Session | None = None) -> None:
        """调用前预算检查（公开入口，修复通道复用；超限抛 BudgetExceededError）。"""
        self._check_budget(task_id, session)

    def record_usage(self, task_id: int | None, stage: str, *,
                     tokens_in: int, tokens_out: int,
                     session: Session | None = None, model: str = "") -> None:
        """写入一条 llm_usage 计量记录（公开入口，token 数由调用方提供）。"""
        if self.session_factory is None:
            return
        usage = LLMUsage(
            task_id=task_id, stage=stage,
            model=model or f"{self.settings.llm_mode}:{self.settings.anthropic_model}",
            tokens_in=tokens_in, tokens_out=tokens_out, cost_est=0.0,
        )
        own = session is None
        s = session or self.session_factory()
        try:
            s.add(usage)
            if own:
                s.commit()
            else:
                s.flush()
        finally:
            if own:
                s.close()

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
