"""Bug 修复阶段（FR-FIX-01 + 11.5 重试反馈回路 + 11.2 出口侧静态校验）。

流程：准备工作区 -> （可选）修复前三维感知基线 -> 经验库检索复用 ->
组装修复指令（重试时注入失败反馈）-> 修复通道执行（LangChain agent / Claude Code CLI）
-> diff 与禁改路径校验 -> 相同 diff 提前终止 -> 留痕入库。
"""

from __future__ import annotations

import json
import logging

from sqlalchemy import select

from ...models import FixRecord, VerificationPlan, VerifyRecord
from ...prompts import load_prompt, prompt_version
from ...services.experience import ExperienceService
from ..stage import StageResult, TaskContext
from ..state import TaskState
from .common import (
    build_bug_block,
    check_forbidden,
    compute_diff,
    diff_hash,
    make_workspace_tools,
    prepare_workspace,
)

logger = logging.getLogger(__name__)


class FixingStage:
    name = "fixing"

    def run(self, ctx: TaskContext) -> StageResult:
        task = ctx.task
        attempt = ctx.attempt
        branch = f"autofix/{ctx.bug.platform_bug_id}"
        workspace = prepare_workspace(ctx)

        # 感知（FR-FIX-02，开关默认关）：修复前采基线快照，摘要注入修复指令
        perception_note = self._capture_pre_fix(ctx)

        prompt_name = "fixing" if attempt == 1 else "fixing_retry"
        prompt, experience_hit = self._build_prompt(ctx, prompt_name, attempt, perception_note)

        # 修复通道：默认 LangChain agent；配置 fix_channel=claude_code_cli 时走 CLI 通道
        channel = ctx.fix_channel or ctx.llm
        agent = channel.create_fix_agent(make_workspace_tools(workspace))
        summary = channel.run_fix_agent(agent, prompt, task_id=task.id, session=ctx.session)

        changed_files, diff = compute_diff(workspace)
        current_hash = diff_hash(diff)

        # 出口侧静态校验（11.2）：禁改路径直接判失败转人工
        violations = check_forbidden(changed_files, ctx.settings.forbidden_paths)
        record = FixRecord(
            task_id=task.id, attempt=attempt, branch=branch, worktree=str(workspace),
            prompt_version=prompt_version(prompt_name), prompt_snapshot=prompt,
            changed_files=changed_files, diff=diff, diff_hash=current_hash, summary=summary,
            experience_hit=experience_hit,
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

        # 连续两次产出相同 diff（哈希比对）-> 提前终止重试，直接进失败分支（11.5）
        prev_hashes = [
            r.diff_hash for r in ctx.session.scalars(
                select(FixRecord).where(FixRecord.task_id == task.id, FixRecord.id != record.id)
            ).all()
        ]
        if current_hash in prev_hashes:
            return StageResult(status="failed", next_state=TaskState.LEARNING,
                               artifacts={"fix_record_id": record.id},
                               message="与历史修复产出相同 diff，提前终止重试")

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

    def _build_prompt(self, ctx: TaskContext, prompt_name: str, attempt: int,
                      perception_note: str = "") -> tuple[str, bool]:
        bug_block = build_bug_block(ctx)
        acceptance = self._acceptance_points(ctx)
        experience_block, experience_hit = self._experience_block(ctx)
        extras = "\n\n".join(part for part in (experience_block, perception_note) if part)
        if extras:
            acceptance = f"{acceptance}\n\n{extras}"
        if prompt_name == "fixing":
            return load_prompt("fixing").format(
                bug_block=bug_block, acceptance=acceptance), experience_hit
        # 11.5：第 N 次（N>=2）修复增量注入失败反馈（结构化摘要，控制 token）
        previous = []
        for r in ctx.session.scalars(select(FixRecord).where(
                FixRecord.task_id == ctx.task.id).order_by(FixRecord.attempt)).all():
            previous.append({"attempt": r.attempt, "changed_files": r.changed_files,
                             "summary": r.summary[:300], "diff_preview": r.diff[:300]})
        evidence = []
        for v in ctx.session.scalars(select(VerifyRecord).where(
                VerifyRecord.task_id == ctx.task.id,
                VerifyRecord.conclusion == "failed")).all():
            failed_steps = [s for s in v.step_results if not s.get("passed")]
            evidence.append({"attempt": v.attempt, "failed_steps": failed_steps})
        return load_prompt("fixing_retry").format(
            attempt=attempt, bug_block=bug_block, acceptance=acceptance,
            previous_attempts=json.dumps(previous, ensure_ascii=False, indent=1),
            failure_evidence=json.dumps(evidence, ensure_ascii=False, indent=1)), experience_hit

    def _experience_block(self, ctx: TaskContext) -> tuple[str, bool]:
        """经验复用回路（FR-MEM-01）：检索命中条目摘要注入修复指令并累计命中次数。"""
        service = ExperienceService(ctx.session)
        keywords = [w for w in ctx.bug.title.replace("/", " ").split() if len(w) >= 2]
        hits = service.find_relevant(modules=ctx.bug.affected_modules,
                                     keywords=keywords, limit=3)
        if not hits:
            return "", False
        lines = ["历史修复经验（可参考，须结合本次 Bug 判断适用性）："]
        for e in hits:
            service.hit(e.id)
            lines.append(f"- [{e.category}] {e.problem_signature}: {e.fix_pattern[:200]}")
        ctx.audit.log(action="experience_hit", target=f"task:{ctx.task.id}",
                      detail={"experience_ids": [e.id for e in hits]}, task_id=ctx.task.id)
        return "\n".join(lines), True

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
