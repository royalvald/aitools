"""Bug 修复阶段（FR-FIX-01 + 11.5 重试反馈回路 + 11.2 出口侧静态校验，Spec 05）。

流程：准备工作区 -> （可选）修复前三维感知基线 -> 经验库检索复用 ->
组装修复指令（首轮含修复思路大纲，重试轮含失败反馈）-> 修复驱动执行
（fix_driver 配置：codex exec 沙箱 / deepseek 工具回路 / claude -p 子进程）
-> 独立 compute_diff
验收（不信任驱动自述）-> 禁改路径 / 零变更 / 相同 diff 出口校验 ->
留痕入库（FixRecord + llm_usage）。
"""

from __future__ import annotations

import json
import logging

from sqlalchemy import select

from autobugfixer.features.fixing.codex import CodexError
from autobugfixer.features.fixing.driver import build_fix_driver
from autobugfixer.common.core.models import FixRecord, VerificationPlan, VerifyRecord
from autobugfixer.common.prompts import prompt_version, render_prompt
from autobugfixer.features.knowledge.experience import ExperienceService
from autobugfixer.common.core.stage import StageResult, TaskContext
from autobugfixer.common.core.state import TaskState
from autobugfixer.common.core.bugtext import build_bug_block
from autobugfixer.common.security.injection import wrap_untrusted
from autobugfixer.features.completeness.repo_profile import render_repo_profiles
from autobugfixer.features.fixing.workspace import (
    check_forbidden,
    compute_diff,
    diff_hash,
    prepare_workspace,
)

logger = logging.getLogger(__name__)


class FixingStage:
    """AI 修复阶段（修复驱动 codex/deepseek/claude + 经验复用、重试反馈、出口校验）。"""

    name = "fixing"

    def run(self, ctx: TaskContext) -> StageResult:
        """准备工作区并以配置的修复驱动执行修复，校验变更后产出 FixRecord，决定下一步状态。"""
        task = ctx.task
        attempt = ctx.attempt
        branch = f"autofix/{ctx.bug.platform_bug_id}"
        workspace = prepare_workspace(ctx)

        # 感知（FR-FIX-02，开关默认关）：修复前采基线快照，摘要注入修复指令
        perception_note = self._capture_pre_fix(ctx)

        prompt_name = "fixing" if attempt == 1 else "fixing_retry"
        prompt, experience_hit = self._build_prompt(ctx, prompt_name, attempt, perception_note)

        # 修复驱动（Spec 05：codex/deepseek/claude 按配置选择）；预算调用前拦截（超限 -> FAILED）
        cli = ctx.codex or build_fix_driver(ctx.settings)
        ctx.llm.check_budget(task.id, ctx.session)
        try:
            result = cli.run(prompt, workspace)
        except CodexError as exc:
            logger.error("修复驱动调用失败（task=%s）: %s", task.id, exc)
            return StageResult(status="failed", next_state=TaskState.FAILED,
                               message=f"修复通道调用失败: {exc}")
        # 事件流用量计量（解析失败已记 0，不阻断；模型名按驱动配置留痕）
        ctx.llm.record_usage(
            task.id, "fixing", tokens_in=result.tokens_in, tokens_out=result.tokens_out,
            session=ctx.session,
            model=f"{ctx.settings.fix_driver}:{getattr(cli, 'model', None) or 'default'}")
        summary = result.summary

        changed_files, diff = compute_diff(workspace)
        current_hash = diff_hash(diff)

        # 出口侧静态校验（11.2）：禁改路径直接判失败转人工
        violations = check_forbidden(changed_files, ctx.settings.forbidden_paths)
        record = FixRecord(
            task_id=task.id, attempt=attempt, branch=branch, worktree=str(workspace),
            prompt_version=prompt_version(prompt_name), prompt_snapshot=prompt,
            changed_files=changed_files, diff=diff, diff_hash=current_hash, summary=summary,
            raw_log=result.raw_log, experience_hit=experience_hit,
        )
        ctx.session.add(record)
        ctx.session.flush()
        ctx.audit.log(action="fix_attempt", target=f"task:{task.id}",
                      detail={"attempt": attempt, "branch": branch,
                              "changed_files": changed_files, "diff_hash": current_hash,
                              "experience_hit": experience_hit},
                      task_id=task.id)

        if violations:
            return StageResult(status="failed", next_state=TaskState.MANUAL,
                               artifacts={"fix_record_id": record.id},
                               message=f"修复产物触碰禁改路径 {violations}，判失败转人工")
        if not changed_files:
            return StageResult(status="failed", next_state=TaskState.FAILED,
                               artifacts={"fix_record_id": record.id},
                               message="修复 agent 未产生任何变更")

        # 连续两次产出相同 diff（哈希比对，11.5）-> 提前终止重试，直接进失败分支。
        # 仅与"上一次"修复比对：跨 FAILED 的人工续跑重产出正确修复不属白烧重试，
        # 全历史比对会把环境类失败后的正确重试误杀（Spec 05 §11.5 语义 = 连续两次）。
        prev = ctx.session.scalar(select(FixRecord).where(
            FixRecord.task_id == task.id, FixRecord.id != record.id
        ).order_by(FixRecord.id.desc()).limit(1))
        if prev is not None and prev.diff_hash == current_hash:
            return StageResult(status="failed", next_state=TaskState.LEARNING,
                               artifacts={"fix_record_id": record.id},
                               message="与上一次修复产出相同 diff，提前终止重试")

        return StageResult(status="success", next_state=TaskState.DEPLOYING,
                           artifacts={"fix_record_id": record.id, "changed_files": changed_files},
                           message=f"第 {attempt} 次修复完成，变更 {len(changed_files)} 个文件")

    # ---- 感知基线 ----

    def _capture_pre_fix(self, ctx: TaskContext) -> str:
        """修复前采基线快照，返回注入 prompt 的摘要文本（未开启/失败时为空串）。"""
        if not (ctx.settings.perception_enabled and ctx.perception is not None):
            return ""
        plan = ctx.session.scalar(select(VerificationPlan).where(
            VerificationPlan.task_id == ctx.task.id).order_by(
            VerificationPlan.version.desc()))
        if plan is None:
            return ""
        try:
            snapshot = ctx.perception.capture(ctx.task, plan, "pre_fix")
            ctx.audit.log(action="perception_capture", target=f"task:{ctx.task.id}",
                          detail={"phase": "pre_fix",
                                  "exceptions": len(snapshot.exceptions)},
                          task_id=ctx.task.id)
            if not snapshot.exceptions:
                return ""
            lines = ["修复前 Bug 表现基线（三维感知）："] + [
                f"- [{e.dimension}/{e.kind}] {e.key} {e.detail}".rstrip()
                for e in snapshot.exceptions[:10]
            ]
            return "\n".join(lines)
        except Exception as exc:  # 感知失败不阻断修复主链路
            logger.warning("pre_fix 感知采集失败: %s", exc)
            return ""

    # ---- prompt 组装（含经验复用回路） ----

    @staticmethod
    def _repo_profile_block(ctx: TaskContext) -> str:
        """关联仓库注入（Spec 02 §9 v2）：全局登记表画像 + 本 Bug 相关性，
        作为修复定位的提示上下文（无画像时回退基础仓库信息，不阻断）。"""
        body = render_repo_profiles(ctx.session, ctx.bug.id)
        if not body:
            return ""
        return "关联仓库画像（LLM 预分析，提示而非约束，以实际代码为准）：\n" + body

    def _build_prompt(self, ctx: TaskContext, prompt_name: str, attempt: int,
                      perception_note: str = "") -> tuple[str, bool]:
        bug_block = build_bug_block(ctx)
        acceptance = self._acceptance_points(ctx)
        experience_block, experience_hit = self._experience_block(ctx)
        extras = "\n\n".join(part for part in (
            self._repo_profile_block(ctx),
            self._fix_approach_block(ctx) if prompt_name == "fixing" else "",
            experience_block, perception_note) if part)
        if extras:
            acceptance = f"{acceptance}\n\n{extras}"
        if prompt_name == "fixing":
            system, user = render_prompt("fixing", bug_block=bug_block, acceptance=acceptance)
            # codex 通道无 system 消息：切分后拼回（模型可见内容不变，仅剥离标记）
            return f"{system}\n\n{user}", experience_hit
        # 11.5：第 N 次（N>=2）修复增量注入失败反馈（结构化摘要，控制 token）
        previous = []
        for r in ctx.session.scalars(select(FixRecord).where(
                FixRecord.task_id == ctx.task.id).order_by(FixRecord.id)).all():
            previous.append({"attempt": r.attempt, "changed_files": r.changed_files,
                             "summary": r.summary[:300], "diff_preview": r.diff[:300]})
        evidence = []
        for v in ctx.session.scalars(select(VerifyRecord).where(
                VerifyRecord.task_id == ctx.task.id,
                VerifyRecord.conclusion == "failed")).all():
            failed_steps = [s for s in v.step_results if not s.get("passed")]
            evidence.append({"attempt": v.attempt, "failed_steps": failed_steps})
        system, user = render_prompt(
            "fixing_retry",
            attempt=attempt, bug_block=bug_block, acceptance=acceptance,
            previous_attempts=json.dumps(previous, ensure_ascii=False, indent=1),
            failure_evidence=json.dumps(evidence, ensure_ascii=False, indent=1))
        return f"{system}\n\n{user}", experience_hit

    def _fix_approach_block(self, ctx: TaskContext) -> str:
        """修复思路大纲注入（Spec 03 §9.4，仅首轮）：从最新方案读取，提示而非约束。"""
        plan = ctx.session.scalar(select(VerificationPlan).where(
            VerificationPlan.task_id == ctx.task.id).order_by(
            VerificationPlan.version.desc()))
        approach = getattr(plan, "fix_approach", None) if plan is not None else None
        if not approach:
            return ""
        locate = "; ".join(approach.get("locate_hints") or [])
        files = "; ".join(approach.get("change_files") or [])
        strategy = approach.get("strategy") or ""
        lines = ["修复思路大纲（来自验证方案，提示而非约束，可依实际代码偏离）："]
        if locate:
            lines.append(f"- 定位线索: {locate}")
        if files:
            lines.append(f"- 拟改动文件: {files}")
        if strategy:
            lines.append(f"- 策略: {strategy}")
        return "\n".join(lines) if len(lines) > 1 else ""

    def _experience_block(self, ctx: TaskContext) -> tuple[str, bool]:
        """经验复用回路（FR-MEM-01）：检索命中条目摘要注入修复指令并累计命中次数。"""
        service = ExperienceService(ctx.session)
        keywords = [w for w in ctx.bug.title.replace("/", " ").split() if len(w) >= 2]
        hits = service.find_relevant(modules=ctx.bug.affected_modules,
                                     keywords=keywords, limit=3)
        if not hits:
            return "", False
        entries = []
        for e in hits:
            service.hit(e.id)
            entries.append(f"- [{e.category}] {e.problem_signature}: {e.fix_pattern[:200]}")
        ctx.audit.log(action="experience_hit", target=f"task:{ctx.task.id}",
                      detail={"experience_ids": [e.id for e in hits]}, task_id=ctx.task.id)
        # 经验条目来自历史修复产物（二阶外部数据，11.2 输入侧）：包裹边界
        block = ("历史修复经验（可参考，须结合本次 Bug 判断适用性）：\n"
                 + wrap_untrusted("\n".join(entries)))
        return block, True

    @staticmethod
    def _acceptance_points(ctx: TaskContext) -> str:
        plan = ctx.session.scalar(select(VerificationPlan).where(
            VerificationPlan.task_id == ctx.task.id).order_by(
            VerificationPlan.version.desc()))
        if plan is None:
            return "(无验证方案)"
        lines = [f"- {s.get('desc') or s.get('action')}" for s in plan.steps]
        lines += [f"- 预期: {e}" for e in plan.expected_results]
        return "\n".join(lines)
