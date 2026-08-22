"""验证阶段（FR-REG-03 + 11.4）：DSL 解释执行，产出结论与证据链，驱动重试环。"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from sqlalchemy import select

from autobugfixer.common.core.models import VerificationPlan, VerifyRecord
from autobugfixer.common.dsl import DSLInterpreter
from autobugfixer.common.core.stage import StageResult, TaskContext
from autobugfixer.common.core.state import TaskState
from autobugfixer.adapters.env.resolve import resolve_executor

logger = logging.getLogger(__name__)


class VerifyingStage:
    """验证阶段（DSL 解释执行 + 重试环 + 感知对比 + 证据落盘）。"""

    name = "verifying"

    def run(self, ctx: TaskContext) -> StageResult:
        """按验证方案执行 DSL 步骤，通过则进经验沉淀，未通过则按重试上限回修复或失败分支。

        环境锁在 finally 中统一释放：正常通过/失败/重试与异常路径都不会泄漏临界区（11.1）。
        """
        task = ctx.task
        # 临界区续期（Spec 06 §3.2）：部署耗时可能已消耗大半租约，验证起点再续一个
        # 周期，避免超 30 分钟的部署+验证被租约回收导致双任务同环境
        if task.environment_id is not None and ctx.env_locks.renew(
                task.environment_id, task.id):
            ctx.audit.log(action="env_lock_renew", target=f"env:{task.environment_id}",
                          detail={"task_id": task.id}, task_id=task.id)
        try:
            plan = ctx.session.scalar(select(VerificationPlan).where(
                VerificationPlan.task_id == task.id).order_by(VerificationPlan.version.desc()))
            if plan is None:
                return StageResult(status="failed", next_state=TaskState.FAILED,
                                   message="缺少验证方案，无法验证")

            executor = resolve_executor(ctx)  # 按 Environment 行解析（ssh/docker 走 registry）
            interpreter = DSLInterpreter(executor)
            results = interpreter.execute(plan.steps)
            passed = all(r.passed for r in results)
            step_results = [
                {"action": r.action, "passed": r.passed, "detail": r.detail, "evidence": r.evidence}
                for r in results
            ]

            # 感知（FR-FIX-02）：修复后对比快照，新增异常记为风险备注
            risk_notes = self._capture_post_fix(ctx, plan)

            record = VerifyRecord(
                task_id=task.id, attempt=ctx.attempt, plan_version=plan.version,
                conclusion="passed" if passed else "failed", step_results=step_results,
                risk_notes=risk_notes,
                evidence_uris=self._dump_evidence(ctx, plan, results),
            )
            ctx.session.add(record)
            ctx.session.flush()
            ctx.audit.log(action="verify", target=f"task:{task.id}",
                          detail={"conclusion": record.conclusion, "plan_version": plan.version,
                                  "risk_notes": bool(risk_notes)},
                          task_id=task.id)

            if passed:
                return StageResult(status="success", next_state=TaskState.LEARNING,
                                   artifacts={"verify_record_id": record.id},
                                   message="全部验证步骤通过")

            failed_steps = [s for s in step_results if not s["passed"]]
            if task.retry_count < task.max_retry:
                # 未达上限：回 FIXING 重试（携带失败证据，11.5 反馈回路）
                return StageResult(status="retry", next_state=TaskState.FIXING,
                                   artifacts={"verify_record_id": record.id,
                                              "failed_steps": failed_steps},
                                   message=f"验证未通过（{len(failed_steps)} 步失败），回修复重试")
            # 达上限：进入本地记忆阶段失败分支（FR-REG-03 规则）
            return StageResult(status="success", next_state=TaskState.LEARNING,
                               artifacts={"verify_record_id": record.id,
                                          "failed_steps": failed_steps},
                               message=f"重试 {task.retry_count} 次仍未通过，进入失败分支")
        finally:
            # 临界区结束：无论通过/失败/异常都释放环境锁（11.1）
            if task.environment_id is not None:
                if ctx.env_locks.release(task.environment_id, task.id):
                    ctx.audit.log(action="env_lock_release", target=f"env:{task.environment_id}",
                                  detail={"task_id": task.id}, task_id=task.id)

    def _dump_evidence(self, ctx: TaskContext, plan: VerificationPlan, results) -> list[str]:
        """证据落盘（Spec 07 §8/§10：evidence_uris 写入点，大证据走文件存储）。

        任一步骤携带证据摘要时，把逐步证据写为 JSON 文件（evidence_root/verify/），
        返回文件 URI 列表；无证据返回空列表。失败仅告警，不阻断验证。
        """
        if not any(r.evidence for r in results):
            return []
        try:
            root = Path(ctx.settings.perception_evidence_root) / "verify"
            root.mkdir(parents=True, exist_ok=True)
            name = f"task-{ctx.task.id}-attempt-{ctx.attempt}.json"
            payload = {
                "task_id": ctx.task.id, "attempt": ctx.attempt,
                "plan_version": plan.version,
                "steps": [{"action": r.action, "passed": r.passed,
                           "detail": r.detail, "evidence": r.evidence} for r in results],
            }
            (root / name).write_text(
                json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
            return [str((root / name).resolve())]
        except Exception as exc:  # 证据落盘失败不影响验证结论
            logger.warning("验证证据落盘失败: %s", exc)
            return []

    def _capture_post_fix(self, ctx: TaskContext, plan: VerificationPlan) -> str:
        """修复后采对比快照并与 pre_fix 基线比对；新增异常（introduced）返回风险备注。"""
        if not (ctx.settings.perception_enabled and ctx.perception is not None):
            return ""
        try:
            post = ctx.perception.capture(ctx.task, plan, "post_fix")
            pre = ctx.perception.load_snapshot(ctx.task.id, "pre_fix")
            if pre is None:
                return ""
            diff = ctx.perception.compare(pre, post)
            ctx.audit.log(action="perception_compare", target=f"task:{ctx.task.id}",
                          detail={"resolved": len(diff.resolved),
                                  "persistent": len(diff.persistent),
                                  "introduced": len(diff.introduced)},
                          task_id=ctx.task.id)
            if diff.introduced:
                return "感知对比发现新增异常（疑似引入性缺陷）:\n" + "\n".join(
                    f"- [{e.dimension}/{e.kind}] {e.key} {e.detail}".rstrip()
                    for e in diff.introduced[:10])
            return ""
        except Exception as exc:  # 感知失败不阻断验证主链路
            logger.warning("post_fix 感知采集/对比失败: %s", exc)
            return ""
