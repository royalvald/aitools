"""完整性分析阶段（FR-PRE-02）：规则快路径 + LLM 评估，不足则介入补充。"""

from __future__ import annotations

from ...prompts import load_prompt, prompt_version
from ..schemas import CompletenessEval
from ..stage import InterventionRequest, StageResult, TaskContext
from ..state import TaskState
from .common import build_bug_block

REQUIRED_FIELDS = ["title", "description", "repro_steps", "expected", "actual", "env_version"]


class CompletenessStage:
    """完整性分析阶段（规则快路径 + LLM 评估）。"""

    name = "completeness"

    def run(self, ctx: TaskContext) -> StageResult:
        """规则快路径检查关键字段，通过后 LLM 评估质量；不足则发起信息补充介入。"""
        bug = ctx.bug
        # 1) 规则检查（快路径）：关键字段非空校验
        missing = [f for f in REQUIRED_FIELDS if not getattr(bug, f, None)]
        if missing:
            return self._need_supplement(ctx, missing, rule_based=True)
        # 2) LLM 评估：文本质量与可修复性
        prompt = load_prompt("completeness").format(bug_block=build_bug_block(ctx))
        result = ctx.llm.analyze(prompt, CompletenessEval,
                                 task_id=ctx.task.id, stage=self.name, session=ctx.session)
        assert isinstance(result, CompletenessEval)
        ctx.audit.log(action="llm_call", target=f"task:{ctx.task.id}",
                      detail={"stage": self.name, "prompt_version": prompt_version("completeness"),
                              "complete": result.complete}, task_id=ctx.task.id)
        if not result.complete:
            return self._need_supplement(ctx, result.missing, suggestions=result.suggestions)
        return StageResult(status="success", next_state=TaskState.PLANNING,
                           message="完整性评估通过")

    def _need_supplement(self, ctx: TaskContext, missing: list[str],
                         suggestions: list[str] | None = None,
                         rule_based: bool = False) -> StageResult:
        # 防死循环：补充往返超上限直接转 MANUAL（4.1.2）
        if ctx.task.info_rounds >= ctx.settings.max_info_rounds:
            return StageResult(status="success", next_state=TaskState.MANUAL,
                               message=f"信息补充往返已达 {ctx.task.info_rounds} 次仍未完整，转人工")
        return StageResult(
            status="need_intervention",
            intervention=InterventionRequest(
                type="info_supplement",
                title=f"Bug {ctx.bug.platform_bug_id} 信息待补充",
                context={"missing_fields": missing, "suggestions": suggestions or [],
                         "rule_based": rule_based},
                assignee_role="tester",
                wait_state=TaskState.WAIT_INFO,
            ),
            message=f"缺少关键信息: {missing}",
        )
