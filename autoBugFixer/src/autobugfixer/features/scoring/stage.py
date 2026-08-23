"""综合难度评分阶段（FR-PRE-04）：三维评分 + 权重合成 + 阈值准入。

双引擎（Spec 04 §8）：
- v1（默认，as-built）：LLM 直接产出三维分，本地按策略权重合成；
- v2（scoring_engine=v2）：本地评价标准模板（rubric）原文注入，AI 只做归类与
  因子判定（判定表单，不产出分数），本地常量映射器产出定位/修改/验证/波及四维分，
  复杂类型（cross_module/data_arch）触发第二次调用做关联仓库代码实证。
准入语义两引擎一致：综合分严格小于阈值才入队。
"""

from __future__ import annotations

import json

from sqlalchemy import select

from autobugfixer.common.core.models import BugRepo, StrategyVersion, VerificationPlan
from autobugfixer.common.prompts import load_prompt, prompt_version
from autobugfixer.common.prompts.rubric import load_rubric
from autobugfixer.features.scoring.schemas import CodeEvidence, JudgmentForm, ScoreOutput
from autobugfixer.features.scoring.v2 import CODE_EVIDENCE_TYPES, map_judgment, search_repos, extract_keywords
from autobugfixer.common.core.stage import StageResult, TaskContext
from autobugfixer.common.core.state import TaskState
from autobugfixer.common.core.bugtext import build_bug_block

WEIGHT_VERSION = "v1"  # v1 权重配置版本，评分解释留痕用
WEIGHT_VERSION_V2 = "v2"  # v2 四维权重配置版本


class ScoringStage:
    """综合难度评分阶段。"""

    name = "scoring"

    def run(self, ctx: TaskContext) -> StageResult:
        """按引擎分支评分后按策略权重合成，超阈值转人工，否则入自动修复队列。"""
        if ctx.settings.scoring_engine == "v2":
            return self._run_v2(ctx)
        return self._run_v1(ctx)

    # ---- v1（as-built：LLM 直接打分） ----

    def _run_v1(self, ctx: TaskContext) -> StageResult:
        """LLM 三维评分后按策略权重合成（Spec 04 §3 as-built 行为）。"""
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
        strategy = self._active_strategy(ctx)
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
        return self._admit(ctx, total, threshold)

    # ---- v2（Spec 04 §8：rubric + 判定表单 + 本地映射，尺子在本地） ----

    def _run_v2(self, ctx: TaskContext) -> StageResult:
        """AI 按评价标准逐项判定，本地映射器产出四维分（LLM 不产出分数）。"""
        rubric = load_rubric()
        plan = self._latest_plan(ctx)
        prompt = load_prompt("scoring_v2").format(
            bug_block=build_bug_block(ctx),
            fix_approach_block=self._fix_approach_block(plan),
            rubric_version=rubric.version,
            rubric_block=rubric.source_text)
        form = ctx.llm.analyze(prompt, JudgmentForm,
                               task_id=ctx.task.id, stage=self.name, session=ctx.session)
        assert isinstance(form, JudgmentForm)
        ctx.audit.log(action="llm_call", target=f"task:{ctx.task.id}",
                      detail={"stage": self.name, "engine": "v2",
                              "prompt_version": prompt_version("scoring_v2"),
                              "rubric_version": rubric.version,
                              "bug_type": form.bug_type,
                              "factors_hit": form.factors_hit}, task_id=ctx.task.id)

        # 代码实证（§8.6）：复杂类型触发第二次调用，从全部关联仓库只读检索
        code_evidence = form.code_evidence
        if form.bug_type in CODE_EVIDENCE_TYPES:
            code_evidence = self._code_evidence(ctx, form)

        dims = map_judgment(rubric, form,
                            affected_modules=ctx.bug.affected_modules,
                            plan_steps=(plan.steps if plan else []),
                            code_evidence=code_evidence)

        s = ctx.settings
        weights = {"locate": s.score_v2_weight_locate, "fix": s.score_v2_weight_fix,
                   "verify": s.score_v2_weight_verify, "blast": s.score_v2_weight_blast}
        threshold = s.admission_threshold
        weight_version = WEIGHT_VERSION_V2
        strategy = self._active_strategy(ctx)
        if strategy is not None:  # 四键部分合并：缺的键沿用配置默认（§8.4 兼容迁移）
            weights.update({k: v for k, v in strategy.weights.items() if k in weights})
            threshold = float(strategy.weights.get("threshold", threshold))
            weight_version = f"strategy:v{strategy.version}"

        total = round(sum(dims.as_dict()[k] * weights[k] for k in weights), 2)
        ctx.task.priority_score = total
        ctx.task.score_detail = {
            **dims.as_dict(),
            "weights": {**weights, "version": weight_version},
            "threshold": threshold,
            "rationale": form.type_evidence,  # 判定证据即评分理由（可反推到类型+因子）
            "rubric_version": rubric.version,
            "bug_type": form.bug_type,
            "factors_hit": sorted(set(form.factors_hit)),
            "code_evidence_triggered": code_evidence.triggered,
        }
        return self._admit(ctx, total, threshold)

    def _code_evidence(self, ctx: TaskContext, form: JudgmentForm) -> CodeEvidence:
        """复杂类型代码实证（§8.6）：仓库只读检索 -> 第二次 LLM 调用。

        仓库可用性由接入层前置保证（Spec 01 §9），不存在"无仓库降级"分支；
        调用失败照常走 Stage 异常 -> FAILED（与其他 analyze 调用口径一致）。
        """
        repo_rows = list(ctx.session.scalars(select(BugRepo).where(
            BugRepo.bug_ticket_id == ctx.bug.id).order_by(BugRepo.seq)).all())
        keywords = extract_keywords(ctx.bug.title, ctx.bug.description, form.type_evidence)
        snippets = search_repos([l.repo for l in repo_rows], keywords)
        prompt = load_prompt("code_evidence").format(
            bug_block=build_bug_block(ctx),
            snippets="\n".join(snippets) or "(未检索到相关片段)")
        result = ctx.llm.analyze(prompt, CodeEvidence,
                                 task_id=ctx.task.id, stage=self.name, session=ctx.session)
        assert isinstance(result, CodeEvidence)
        ctx.audit.log(action="code_evidence", target=f"task:{ctx.task.id}",
                      detail={"bug_type": form.bug_type, "triggered": result.triggered,
                              "suspected_files": result.suspected_files,
                              "snippets": len(snippets)}, task_id=ctx.task.id)
        return result

    # ---- 共用 ----

    def _admit(self, ctx: TaskContext, total: float, threshold: float) -> StageResult:
        """准入判定（两引擎一致：严格小于阈值才入队）。"""
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
    def _active_strategy(ctx: TaskContext) -> StrategyVersion | None:
        return ctx.session.scalar(select(StrategyVersion).where(
            StrategyVersion.active.is_(True)))

    @staticmethod
    def _latest_plan(ctx: TaskContext) -> VerificationPlan | None:
        return ctx.session.scalar(select(VerificationPlan).where(
            VerificationPlan.task_id == ctx.task.id).order_by(
            VerificationPlan.version.desc()))

    @staticmethod
    def _fix_approach_block(plan: VerificationPlan | None) -> str:
        """修复思路大纲可读块（Spec 03 §9.4 -> Spec 04 §8.7 触点 8：注入评分证据）。"""
        approach = (plan.fix_approach or {}) if plan is not None else {}
        if not approach:
            return "(未提供)"
        lines = []
        if approach.get("locate_hints"):
            lines.append(f"- 定位线索: {'; '.join(approach['locate_hints'])}")
        if approach.get("change_files"):
            lines.append(f"- 拟改动文件: {'; '.join(approach['change_files'])}")
        if approach.get("strategy"):
            lines.append(f"- 策略: {approach['strategy']}")
        return "\n".join(lines) or "(未提供)"

    @staticmethod
    def _plan_summary(ctx: TaskContext) -> str:
        """取最新验证方案的可读摘要，作为评分 prompt 的"验证方案摘要"输入。

        跨阶段数据一律从库中读取（ctx.data 只在单次 stage.run 内有效，
        不能用于 stage 间传递）。
        """
        plan = ScoringStage._latest_plan(ctx)
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
    from autobugfixer.features.intervention.notifier import NoticeMessage

    return NoticeMessage(title=title, content=str(detail)[:500])
