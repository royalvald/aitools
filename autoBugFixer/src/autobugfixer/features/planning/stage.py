"""验证方案生成阶段（FR-PRE-03 + 11.4）：LLM 以 DSL 输出结构化方案，高风险转人工确认。

Spec 03 §8：planning 模板渲染 {skill_library} 动态段（验证侧经验库复用），
LLM 可携带 proposed_skills 提议组合校验技能（首次仅内联展开落库，
验证通过后由学习阶段蒸馏入库）；引用技能的方案保存时展开为原始步骤，
执行与技能库后续变更完全解耦。

Spec 02 §9 v3：Bug x 仓库对应关系由本阶段 LLM 一并判定——候选登记表
（声明链接仓库 + 登记表其他可用候选，画像全局缓存）注入 prompt，LLM 输出
target_repos 后写回 bug_repo（声明链接补相关性、未声明的建 matched 链接），
驱动工作区准备与代码检索；未声明 Bug 零选定时发 repo_supplement 介入。
"""

from __future__ import annotations

from sqlalchemy import delete

from autobugfixer.common.core.models import BugRepo, VerificationPlan, utcnow
from autobugfixer.common.prompts import prompt_version, render_prompt
from autobugfixer.features.knowledge.skill import SkillService, render_skill_library
from autobugfixer.common.dsl import DSL_VERSION
from autobugfixer.features.planning.schemas import PlanOutput
from autobugfixer.common.core.stage import InterventionRequest, StageResult, TaskContext
from autobugfixer.common.core.state import TaskState
from autobugfixer.common.core.bugtext import build_bug_block
from autobugfixer.features.completeness.repo_profile import (
    candidate_library_block,
    ensure_profiles,
    load_repo_candidates,
)


class PlanningStage:
    """验证方案生成阶段（DSL 方案 + 目标仓库选定）。"""

    name = "planning"

    def run(self, ctx: TaskContext) -> StageResult:
        """LLM 生成 DSL 结构化验证方案并选定目标仓库；命中高风险模块则转人工确认。"""
        skills = SkillService(ctx.session).list_active()
        # 候选仓库（Spec 02 §9 v3）：声明链接 + 登记表补选；画像全局缓存补齐
        candidates = load_repo_candidates(ctx)
        ensure_profiles(ctx, candidates)
        repo_library = (candidate_library_block(candidates)
                        if ctx.settings.repo_profile_enabled and candidates else "（无候选仓库）")
        system, user = render_prompt(
            "planning",
            bug_block=build_bug_block(ctx),
            repo_profiles=repo_library,
            skill_library=render_skill_library(skills))
        # DSL 以 JSON Schema 约束输出，校验失败由 Gateway 附错误反馈重试（11.4）；
        # 方案含多步骤/技能提议/选仓判定，输出上限放宽到 8192 防 JSON 截断
        result = ctx.llm.analyze(user, PlanOutput, system=system, max_tokens=8192,
                                 task_id=ctx.task.id, stage=self.name, session=ctx.session)
        assert isinstance(result, PlanOutput)

        # 风险分级：影响模块 ∩ 配置的高风险模块清单
        hit_risk = sorted(set(ctx.bug.affected_modules) & set(ctx.settings.high_risk_modules))
        risk_level = "high" if hit_risk else "low"

        plan = VerificationPlan(
            task_id=ctx.task.id, dsl_version=DSL_VERSION,
            env_requirements=result.env_requirements,
            steps=[s.model_dump() for s in result.steps],
            expected_results=result.expected_results,
            function_points=result.function_points,
            regression_scope=result.regression_scope,
            fix_approach=(result.fix_approach.model_dump()
                          if result.fix_approach else {}),  # Spec 03 §9.4
            proposed_skills=[s.model_dump() for s in result.proposed_skills],  # Spec 03 §8
            risk_level=risk_level,
        )
        ctx.session.add(plan)
        ctx.session.flush()
        ctx.audit.log(action="llm_call", target=f"task:{ctx.task.id}",
                      detail={"stage": self.name, "prompt_version": prompt_version("planning"),
                              "plan_id": plan.id, "risk_level": risk_level,
                              "candidates": len(candidates)},
                      task_id=ctx.task.id)
        self._account_skills(ctx, result, plan)

        # 对应关系写回 bug_repo（Spec 02 §9 v3）：无任何绑定时发仓库补充介入
        if not self._bind_target_repos(ctx, result, candidates):
            return self._need_repo_supplement(ctx)

        if risk_level == "high":
            # 高风险模块的验证方案必须经人工确认后方可执行（FR-PRE-03 规则）
            return StageResult(
                status="need_intervention",
                intervention=InterventionRequest(
                    type="plan_confirm",
                    title=f"Bug {ctx.bug.platform_bug_id} 验证方案待确认（命中高风险模块: {hit_risk}）",
                    context={"plan_id": plan.id, "steps": plan.steps, "hit_risk_modules": hit_risk},
                    assignee_role="tech_lead",
                    wait_state=TaskState.WAIT_PLAN,
                ),
                artifacts={"plan_id": plan.id},
                message="方案命中高风险模块，待人工确认",
            )
        # 方案重生成 -> 旧评分作废（run_preprocessing 收尾步按"未评分"重评），
        # 避免 SCORED 任务带着过期分数出队
        ctx.task.priority_score = None
        return StageResult(status="success", next_state=TaskState.SCORED,
                           artifacts={"plan_id": plan.id}, message="低风险方案自动通过")

    # ---- 目标仓库写回（Spec 02 §9 v3） ----

    def _bind_target_repos(self, ctx: TaskContext, result: PlanOutput,
                           candidates: list) -> bool:
        """把 target_repos 判定写回 bug_repo；返回是否存在可用绑定。

        - repo_id 解析限定候选集，集外 id 忽略并留痕（防幻觉引用）；
        - 声明链接（origin=declared）强制保留（信任用户指定），判定命中补相关性；
        - 未声明的判定仓库重建 matched 链接（先删旧再按判定顺序追加，幂等）；
        - 开关关闭时不做写回（声明链接即绑定，下游回退基础仓库信息）。
        """
        from autobugfixer.features.ingest.repo_check import load_bug_repos

        links = load_bug_repos(ctx.session, ctx.bug.id)
        if not ctx.settings.repo_profile_enabled:
            return bool(links)
        candidate_ids = {r.id for r in candidates}
        judgments: dict[int, str] = {}
        for t in result.target_repos:
            if t.repo_id in candidate_ids:
                judgments[t.repo_id] = t.reason[:500]
            else:
                ctx.audit.log(action="target_repo_ignored", target=f"task:{ctx.task.id}",
                              detail={"repo_id": t.repo_id, "reason": "候选集外 id"},
                              task_id=ctx.task.id)

        now = utcnow()
        declared_ids = set()
        for link in links:
            if link.origin == "declared":
                declared_ids.add(link.repo_id)
                if link.repo_id in judgments:  # 声明仓库的判定只作相关性标注
                    link.relevance = judgments[link.repo_id]
                    link.matched_at = now
        # 补选链接：重建（先删旧 matched，再按判定顺序追加）
        session = ctx.session
        session.execute(delete(BugRepo).where(
            BugRepo.bug_ticket_id == ctx.bug.id, BugRepo.origin == "matched"))
        added = 0
        for rid, reason in judgments.items():
            if rid in declared_ids:
                continue
            session.add(BugRepo(bug_ticket_id=ctx.bug.id, repo_id=rid,
                                seq=len(declared_ids) + added, origin="matched",
                                relevance=reason, matched_at=now))
            added += 1
        session.flush()
        ctx.audit.log(action="repo_bind", target=f"task:{ctx.task.id}",
                      detail={"declared": len(declared_ids), "matched_added": added,
                              "candidates": len(candidates)},
                      task_id=ctx.task.id)
        return bool(declared_ids) or added > 0

    def _need_repo_supplement(self, ctx: TaskContext) -> StageResult:
        """未声明 Bug 且方案生成零选定：请人工补充仓库声明（止损上限保护）。"""
        if ctx.task.info_rounds >= ctx.settings.max_info_rounds:
            return StageResult(status="success", next_state=TaskState.MANUAL,
                               message=f"仓库补充往返已达 {ctx.task.info_rounds} 次仍未补全，转人工")
        return StageResult(
            status="need_intervention",
            intervention=InterventionRequest(
                type="repo_supplement",
                title=f"Bug {ctx.bug.platform_bug_id} 修复仓库待补充",
                context={"missing_repos": [
                    {"path": "", "branch": "main", "status": "unavailable",
                     "reason": "方案生成未从登记表选定目标仓库，请补充仓库声明"}],
                    "rule_based": False},
                assignee_role="tester",
                wait_state=TaskState.WAIT_INFO,
            ),
            message="方案生成未选定目标仓库，待补充声明",
        )

    @staticmethod
    def _account_skills(ctx: TaskContext, result: PlanOutput, plan: VerificationPlan) -> None:
        """技能治理留痕（Spec 03 §8）：提议写 skill_proposed 审计；方案步骤
        结构命中库内技能模板 -> 判定引用，use_count+1 并写 skill_used 审计。
        """
        service = SkillService(ctx.session)
        for prop in result.proposed_skills:
            ctx.audit.log(action="skill_proposed", target=f"task:{ctx.task.id}",
                          detail={"name": prop.name, "params": prop.params,
                                  "plan_id": plan.id}, task_id=ctx.task.id)
        for skill in service.match_uses(plan.steps):
            service.record_use(skill.id)
            ctx.audit.log(action="skill_used", target=f"skill:{skill.id}",
                          detail={"name": skill.name, "plan_id": plan.id,
                                  "use_count": skill.use_count}, task_id=ctx.task.id)
