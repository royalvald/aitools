"""综合难度评分阶段（FR-PRE-04）：三维评分 + 权重合成 + 阈值准入。"""

from __future__ import annotations

import json

from sqlalchemy import select

from ...models import StrategyVersion, VerificationPlan
from ...prompts import load_prompt, prompt_version
from ..schemas import ScoreOutput
from ..stage import StageResult, TaskContext
from ..state import TaskState
from .common import build_bug_block

WEIGHT_VERSION = "v1"  # 权重配置版本，评分解释留痕用


class ScoringStage:
    """综合难度评分阶段。"""

    name = "scoring"

    def run(self, ctx: TaskContext) -> StageResult:
        """LLM 三维评分后按策略权重合成，超阈值转人工，否则入自动修复队列。"""
        plan_summary = self._plan_summary(ctx)
        prompt = load_prompt("scoring").format(
            bug_block=build_bug_block(ctx), plan_summary=plan_summary or "见验证方案")
        result = ctx.llm.analyze(prompt, ScoreOutput,
                                 task_id=ctx.task.id, stage=self.name, session=ctx.session)
        assert isinstance(result, ScoreOutput)

        # 策略版本（FR-SYS-02）：存在生效版本时覆盖配置的权重与阈值
        s = ctx.settings
        weights = {"fix": s.score_weight_fix, "verify": s.score_weight_verify,
                   "change": s.score_weight_change}
        threshold = s.admission_threshold
        weight_version = WEIGHT_VERSION
        strategy = ctx.session.scalar(select(StrategyVersion).where(
            StrategyVersion.active.is_(True)))
        if strategy is not None:
            weights.update({k: v for k, v in strategy.weights.items() if k in weights})
            threshold = float(strategy.weights.get("threshold", threshold))
            weight_version = f"strategy:v{strategy.version}"

        total = round(result.fix_difficulty * weights["fix"]
                      + result.verify_difficulty * weights["verify"]
                      + result.change_scale * weights["change"], 2)
        # 评分可查询、可解释：各维度得分 + 权重版本 + LLM 理由全量落库
        ctx.task.priority_score = total
        ctx.task.score_detail = {
            "fix_difficulty": result.fix_difficulty,
            "verify_difficulty": result.verify_difficulty,
            "change_scale": result.change_scale,
            "weights": {**weights, "version": weight_version},
            "threshold": threshold,
            "rationale": result.rationale,
        }
        ctx.audit.log(action="llm_call", target=f"task:{ctx.task.id}",
                      detail={"stage": self.name, "prompt_version": prompt_version("scoring"),
                              "score": total}, task_id=ctx.task.id)

        if total >= threshold:
            # 评分超阈值 -> 转人工并附评分解释（9.3 约束：评分准入）
            ctx.notifier.send("developer", _notice(
                f"Bug {ctx.bug.platform_bug_id} 评分 {total} 超阈值，转人工",
                ctx.task.score_detail))
            return StageResult(status="success", next_state=TaskState.MANUAL,
                               artifacts={"score": total},
                               message=f"综合分 {total} >= 阈值 {threshold}，转人工")
        # 低于阈值 -> 入自动修复队列（按分数升序调度，先易后难）
        return StageResult(status="success", next_state=TaskState.FIXING,
                           artifacts={"score": total},
                           message=f"综合分 {total} 准入自动修复队列")

    @staticmethod
    def _plan_summary(ctx: TaskContext) -> str:
        """取最新验证方案的可读摘要，作为评分 prompt 的"验证方案摘要"输入。

        跨阶段数据一律从库中读取（ctx.data 只在单次 stage.run 内有效，
        不能用于 stage 间传递）。
        """
        plan = ctx.session.scalar(select(VerificationPlan).where(
            VerificationPlan.task_id == ctx.task.id).order_by(
            VerificationPlan.version.desc()))
        if plan is None:
            return ""
        lines = [
            s.get("desc") or f"{s.get('action')} {json.dumps(s.get('params', {}), ensure_ascii=False)}"
            for s in (plan.steps or [])
        ]
        text = "\n".join(lines)[:500]
        if plan.expected_results:
            text = f"{text}\n预期: {'; '.join(plan.expected_results)}"[:500]
        return text


def _notice(title: str, detail: dict):
    from ...adapters.notifier import NoticeMessage

    return NoticeMessage(title=title, content=str(detail)[:500])
