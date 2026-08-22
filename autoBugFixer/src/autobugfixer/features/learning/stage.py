"""经验沉淀阶段（FR-MEM-01/02，P1 简化版）。

成功分支：经验条目入库 -> 回写平台关闭缺陷单 -> CLOSED；
失败分支：记录不适用场景 -> 生成人工讨论议题（WAIT_DISCUSS 介入）。
"""

from __future__ import annotations

from sqlalchemy import select

from autobugfixer.features.intervention.notifier import NoticeMessage
from autobugfixer.common.core.models import FixRecord, InapplicableCase, VerifyRecord
from autobugfixer.common.prompts import load_prompt
from autobugfixer.features.knowledge.experience import ExperienceService
from autobugfixer.features.learning.schemas import FailureAnalysis
from autobugfixer.common.core.stage import InterventionRequest, StageResult, TaskContext
from autobugfixer.common.core.state import TaskState
from autobugfixer.common.core.bugtext import build_bug_block


class LearningStage:
    """经验沉淀阶段（成功入库 / 失败讨论两条分支）。"""

    name = "learning"

    def run(self, ctx: TaskContext) -> StageResult:
        """按最近验证结论分流：通过则经验入库并关闭缺陷单，未通过则生成讨论议题。"""
        task = ctx.task
        last_verify = ctx.session.scalar(select(VerifyRecord).where(
            VerifyRecord.task_id == task.id).order_by(VerifyRecord.id.desc()))
        verified = last_verify is not None and last_verify.conclusion == "passed"

        if verified:
            return self._success_branch(ctx, last_verify)
        return self._failure_branch(ctx, last_verify)

    # ---- 成功分支：经验入库 + 平台回写关闭 ----

    def _success_branch(self, ctx: TaskContext, verify: VerifyRecord) -> StageResult:
        fix = ctx.session.scalar(select(FixRecord).where(
            FixRecord.task_id == ctx.task.id).order_by(FixRecord.id.desc()))
        digest = self._digest_experience(ctx, fix, verify)
        category = digest.category or self._classify(ctx)
        # 比对去重：同 category + problem_signature 合并更新而非重复新增（FR-MEM-01）
        ExperienceService(ctx.session).upsert(
            category=category,
            problem_signature=ctx.bug.title,
            symptoms=ctx.bug.actual[:500],
            root_cause_pattern=digest.root_cause_pattern[:500],  # LLM 归因（Spec 08 §7）
            fix_pattern=(fix.summary if fix else "")[:500],
            verification_points="; ".join(
                s.get("desc") or s.get("action", "") for s in (verify.step_results or []))[:500],
            applicable_conditions=f"env={ctx.bug.env_version}",
            source_task_ids=[ctx.task.id],
        )
        # 技能蒸馏（Spec 03 §8）：验证通过的提议技能入库沉淀（技能库 = 验证侧经验库）
        self._distill_skills(ctx)
        # 平台状态回写由状态机迁移钩子统一处理（status_map，CLOSED->已关闭）
        ctx.notifier.send("tester", NoticeMessage(
            title=f"Bug {ctx.bug.platform_bug_id} 已自动修复关闭",
            content=f"任务 #{ctx.task.id} 验证通过", link=f"/tasks/{ctx.task.id}"))
        return StageResult(status="success", next_state=TaskState.CLOSED,
                           message="经验已沉淀，缺陷单已关闭")

    def _digest_experience(self, ctx: TaskContext, fix, verify: VerifyRecord):
        """LLM 归因与分类（Spec 08 §7 已知限制修复）：异常时回退空摘要（分类走
        关键词规则、root_cause 不覆盖），成功分支绝不因 LLM 故障中断。
        """
        from autobugfixer.features.learning.schemas import ExperienceDigest

        verification_points = "; ".join(
            s.get("desc") or s.get("action", "") for s in (verify.step_results or []))[:300]
        prompt = load_prompt("experience_digest").format(
            bug_block=build_bug_block(ctx),
            fix_pattern=(fix.summary if fix else "")[:500],
            verification_points=verification_points)
        try:
            result = ctx.llm.analyze(prompt, ExperienceDigest,
                                     task_id=ctx.task.id, stage=self.name,
                                     session=ctx.session)
            assert isinstance(result, ExperienceDigest)
            return result
        except Exception:
            return ExperienceDigest()

    def _distill_skills(self, ctx: TaskContext) -> None:
        """验证通过后蒸馏提议技能（Spec 03 §8 入库沉淀：去重合并、upsert、
        记录来源任务与使用统计）。
        """
        from autobugfixer.common.core.models import VerificationPlan
        from autobugfixer.features.knowledge.skill import SkillService

        plan = ctx.session.scalar(select(VerificationPlan).where(
            VerificationPlan.task_id == ctx.task.id).order_by(
            VerificationPlan.version.desc()))
        proposals = (plan.proposed_skills or []) if plan is not None else []
        if not proposals:
            return
        service = SkillService(ctx.session)
        for prop in proposals:
            skill, created = service.upsert(
                name=prop.get("name", ""), params=prop.get("params") or [],
                desc=prop.get("desc", ""), template_steps=prop.get("steps") or [],
                source_task_id=ctx.task.id)
            ctx.audit.log(action="skill_distilled", target=f"skill:{skill.id}",
                          detail={"name": skill.name, "created": created,
                                  "version": skill.version,
                                  "template_steps": len(prop.get("steps") or [])},
                          task_id=ctx.task.id)

    # ---- 失败分支：LLM 汇总不适用场景 + 人工讨论议题（FR-MEM-02） ----

    def _failure_branch(self, ctx: TaskContext, verify: VerifyRecord | None) -> StageResult:
        failed_steps = [s for s in (verify.step_results or []) if not s.get("passed")] if verify else []
        analysis = self._analyze_failure(ctx, failed_steps)
        case = InapplicableCase(
            task_id=ctx.task.id,
            condition_desc=analysis.condition_desc or (
                f"模块 {ctx.bug.affected_modules} / 环境 {ctx.bug.env_version}"),
            reason=analysis.reason or (
                f"重试 {ctx.task.retry_count} 次仍未通过验证，失败步骤: "
                f"{[s.get('action') for s in failed_steps]}"),
            discussion_topic=analysis.discussion_topic or (
                f"Bug {ctx.bug.platform_bug_id}（{ctx.bug.title}）自动修复失败，"
                f"请评审不适用场景并决定人工接手方案"),
        )
        ctx.session.add(case)
        ctx.session.flush()
        return StageResult(
            status="need_intervention",
            intervention=InterventionRequest(
                type="discussion",
                title=f"Bug {ctx.bug.platform_bug_id} 修复失败待讨论",
                context={"inapplicable_case_id": case.id, "reason": case.reason,
                         "failed_steps": failed_steps},
                assignee_role="developer",
                wait_state=TaskState.WAIT_DISCUSS,
            ),
            message="已达重试上限，生成不适用场景与讨论议题",
        )

    def _analyze_failure(self, ctx: TaskContext, failed_steps: list[dict]) -> FailureAnalysis:
        """LLM 结构化汇总失败全过程；调用失败时回退规则模板。"""
        import json

        prompt = load_prompt("failure_analysis").format(
            bug_block=build_bug_block(ctx),
            retry_count=ctx.task.retry_count, max_retry=ctx.task.max_retry,
            failed_steps=json.dumps(failed_steps, ensure_ascii=False)[:1000])
        try:
            result = ctx.llm.analyze(prompt, FailureAnalysis,
                                     task_id=ctx.task.id, stage=self.name,
                                     session=ctx.session)
            assert isinstance(result, FailureAnalysis)
            return result
        except Exception:
            return FailureAnalysis()

    @staticmethod
    def _classify(ctx: TaskContext) -> str:
        """关键词五级规则分类（LLM 归因调用的回退路径，Spec 08 §7）。"""
        text = f"{ctx.bug.title} {ctx.bug.description}"
        if any(k in text for k in ("接口", "api", "API", "请求")):
            return "接口类"
        if any(k in text for k in ("数据", "SQL", "库")):
            return "数据类"
        if any(k in text for k in ("页面", "界面", "按钮", "显示")):
            return "界面类"
        if any(k in text for k in ("部署", "环境", "配置")):
            return "环境类"
        return "其他"
