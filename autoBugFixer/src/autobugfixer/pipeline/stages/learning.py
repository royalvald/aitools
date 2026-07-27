"""经验沉淀阶段（FR-MEM-01/02，P1 简化版）。

成功分支：经验条目入库 -> 回写平台关闭缺陷单 -> CLOSED；
失败分支：记录不适用场景 -> 生成人工讨论议题（WAIT_DISCUSS 介入）。
"""

from __future__ import annotations

from sqlalchemy import select

from ...adapters.notifier import NoticeMessage
from ...models import FixRecord, InapplicableCase, VerifyRecord
from ...prompts import load_prompt
from ...services.experience import ExperienceService
from ..schemas import FailureAnalysis
from ..stage import InterventionRequest, StageResult, TaskContext
from ..state import TaskState
from .common import build_bug_block


class LearningStage:
    name = "learning"

    def run(self, ctx: TaskContext) -> StageResult:
        task = ctx.task
        last_verify = ctx.session.scalar(select(VerifyRecord).where(
            VerifyRecord.task_id == task.id).order_by(VerifyRecord.attempt.desc()))
        verified = last_verify is not None and last_verify.conclusion == "passed"

        if verified:
            return self._success_branch(ctx, last_verify)
        return self._failure_branch(ctx, last_verify)

    # ---- 成功分支：经验入库 + 平台回写关闭 ----

    def _success_branch(self, ctx: TaskContext, verify: VerifyRecord) -> StageResult:
        fix = ctx.session.scalar(select(FixRecord).where(
            FixRecord.task_id == ctx.task.id).order_by(FixRecord.attempt.desc()))
        category = self._classify(ctx)
        # 比对去重：同 category + problem_signature 合并更新而非重复新增（FR-MEM-01）
        ExperienceService(ctx.session).upsert(
            category=category,
            problem_signature=ctx.bug.title,
            symptoms=ctx.bug.actual[:500],
            root_cause_pattern="",  # P1：LLM 归因总结
            fix_pattern=(fix.summary if fix else "")[:500],
            verification_points="; ".join(
                s.get("desc") or s.get("action", "") for s in (verify.step_results or []))[:500],
            applicable_conditions=f"env={ctx.bug.env_version}",
            source_task_ids=[ctx.task.id],
        )
        # 平台状态回写由状态机迁移钩子统一处理（status_map，CLOSED->已关闭）
        ctx.notifier.send("tester", NoticeMessage(
            title=f"Bug {ctx.bug.platform_bug_id} 已自动修复关闭",
            content=f"任务 #{ctx.task.id} 验证通过", link=f"/tasks/{ctx.task.id}"))
        return StageResult(status="success", next_state=TaskState.CLOSED,
                           message="经验已沉淀，缺陷单已关闭")

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
        """简化分类：按 Bug 文本关键词归类（P1 改 LLM 分类，类目可配置扩展）。"""
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
