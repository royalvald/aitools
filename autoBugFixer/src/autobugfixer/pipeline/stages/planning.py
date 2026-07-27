"""验证方案生成阶段（FR-PRE-03 + 11.4）：LLM 以 DSL 输出结构化方案，高风险转人工确认。"""

from __future__ import annotations

from ...models import VerificationPlan
from ...prompts import load_prompt, prompt_version
from ..dsl import DSL_VERSION
from ..schemas import PlanOutput
from ..stage import InterventionRequest, StageResult, TaskContext
from ..state import TaskState
from .common import build_bug_block


class PlanningStage:
    name = "planning"

    def run(self, ctx: TaskContext) -> StageResult:
        prompt = load_prompt("planning").format(bug_block=build_bug_block(ctx))
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
            risk_level=risk_level,
        )
        ctx.session.add(plan)
        ctx.session.flush()
        ctx.audit.log(action="llm_call", target=f"task:{ctx.task.id}",
                      detail={"stage": self.name, "prompt_version": prompt_version("planning"),
                              "plan_id": plan.id, "risk_level": risk_level},
                      task_id=ctx.task.id)

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
        return StageResult(status="success", next_state=TaskState.SCORED,
                           artifacts={"plan_id": plan.id}, message="低风险方案自动通过")
