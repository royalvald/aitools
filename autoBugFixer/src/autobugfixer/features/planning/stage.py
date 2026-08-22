"""验证方案生成阶段（FR-PRE-03 + 11.4）：LLM 以 DSL 输出结构化方案，高风险转人工确认。

Spec 03 §8：planning 模板渲染 {skill_library} 动态段（验证侧经验库复用），
LLM 可携带 proposed_skills 提议组合校验技能（首次仅内联展开落库，
验证通过后由学习阶段蒸馏入库）；引用技能的方案保存时展开为原始步骤，
执行与技能库后续变更完全解耦。
"""

from __future__ import annotations

from sqlalchemy import select

from autobugfixer.common.core.models import VerificationPlan
from autobugfixer.common.prompts import load_prompt, prompt_version
from autobugfixer.features.knowledge.skill import SkillService, render_skill_library
from autobugfixer.common.dsl import DSL_VERSION
from autobugfixer.features.planning.schemas import PlanOutput
from autobugfixer.common.core.stage import InterventionRequest, StageResult, TaskContext
from autobugfixer.common.core.state import TaskState
from autobugfixer.common.core.bugtext import build_bug_block


class PlanningStage:
    """验证方案生成阶段。"""

    name = "planning"

    def run(self, ctx: TaskContext) -> StageResult:
        """LLM 生成 DSL 结构化验证方案并落库；命中高风险模块则转人工确认。"""
        skills = SkillService(ctx.session).list_active()
        prompt = load_prompt("planning").format(
            bug_block=build_bug_block(ctx),
            skill_library=render_skill_library(skills))
        # DSL 以 JSON Schema 约束输出，校验失败由 Gateway 自动重试（11.4）
        result = ctx.llm.analyze(prompt, PlanOutput,
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
                              "plan_id": plan.id, "risk_level": risk_level},
                      task_id=ctx.task.id)
        self._account_skills(ctx, result, plan)

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
