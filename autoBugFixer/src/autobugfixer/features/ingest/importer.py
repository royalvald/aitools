"""CSV 导入服务：逐行入库（幂等去重）+ 导入后预处理分析汇总。"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from autobugfixer.features.ingest.csv_import import ParseResult
from autobugfixer.common.core.models import BugTicket, Task, VerificationPlan
from autobugfixer.runtime.orchestrator import Orchestrator
from autobugfixer.common.core.state import TaskState
from autobugfixer.common.core.audit import AuditService
from autobugfixer.features.ingest.ingestion import ingest_bug

# 预处理终点状态 -> 准入结论
ADMISSION_LABELS = {
    TaskState.SCORED: "入队",
    TaskState.MANUAL: "转人工",
    TaskState.WAIT_INFO: "待补充",
    TaskState.WAIT_PLAN: "待方案确认",
}


def import_bug_rows(session: Session, parsed: ParseResult, *,
                    platform: str = "csv", max_retry: int = 3,
                    source: str = "") -> dict[str, Any]:
    """把解析结果逐行导入为标准任务。重复 bug_id（同 platform）按幂等规则跳过。"""
    result: dict[str, Any] = {
        "total": len(parsed.rows) + len(parsed.failures),
        "imported": 0,
        "skipped": 0,
        "failed": [{"row": f.row, "reason": f.reason} for f in parsed.failures],
        "task_ids": [],
    }
    for row in parsed.rows:
        row.platform = platform
        task, created = ingest_bug(session, row, max_retry=max_retry)
        if created:
            result["imported"] += 1
            result["task_ids"].append(task.id)
        else:
            result["skipped"] += 1
    AuditService(session).log(
        action="csv_import", target=source or platform,
        detail={"total": result["total"], "imported": result["imported"],
                "skipped": result["skipped"], "failed": len(result["failed"])})
    session.flush()
    return result


def analyze_tasks(orchestrator: Orchestrator,
                  session_factory: sessionmaker[Session],
                  task_ids: list[int]) -> list[dict[str, Any]]:
    """对导入任务依次跑预处理三阶段（Fake LLM 同样可用），输出分析汇总。

    不会进入 FIXING：准入任务停在 SCORED（入队），其余停在 MANUAL/WAIT_INFO/WAIT_PLAN。
    """
    summaries: list[dict[str, Any]] = []
    for task_id in task_ids:
        final = orchestrator.run_preprocessing(task_id)
        with session_factory() as s:
            task = s.get(Task, task_id)
            bug = s.get(BugTicket, task.bug_ticket_id)
            plan = s.scalar(select(VerificationPlan).where(
                VerificationPlan.task_id == task_id).order_by(
                VerificationPlan.version.desc()))
            score_detail = task.score_detail or {}
            if any(k in score_detail for k in ("fix_difficulty", "verify_difficulty", "change_scale")):
                scores = {k: score_detail.get(k) for k in
                          ("fix_difficulty", "verify_difficulty", "change_scale")}
            else:  # 评分 v2 四维（Spec 04 §8.4：定位/修改/验证/波及）
                scores = {k: score_detail.get(k) for k in
                          ("locate", "fix", "verify", "blast")}
            summaries.append({
                "task_id": task_id,
                "bug_id": bug.platform_bug_id,
                "title": bug.title,
                "complete": final != TaskState.WAIT_INFO,
                "risk_level": plan.risk_level if plan else None,
                "scores": scores if score_detail else None,
                "priority_score": task.priority_score,
                "state": final.value,
                "admission": ADMISSION_LABELS.get(final, final.value),
            })
    return summaries
