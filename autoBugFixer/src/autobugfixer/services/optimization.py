"""自我优化评审（FR-SYS-02 简化版，P2，需人工介入）。

基于经验库与任务统计生成评分策略优化建议 -> 创建「优化评审」介入单；
研发批准后写入版本化策略表（strategy_version）并生效；支持回退到指定版本。
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Experience, Intervention, StrategyVersion, Task, VerifyRecord
from ..pipeline.stage import InterventionRequest
from ..pipeline.state import TaskState
from .audit import AuditService
from .intervention import InterventionService


def compute_stats(session: Session) -> dict:
    """优化依据统计：失败模式分布、评分偏差（通过 vs 失败任务的平均分）。"""
    tasks = list(session.scalars(select(Task)).all())
    closed_scores = [t.priority_score for t in tasks
                     if t.state == TaskState.CLOSED.value and t.priority_score is not None]
    failed_scores = [t.priority_score for t in tasks
                     if t.state in (TaskState.MANUAL.value, TaskState.WAIT_DISCUSS.value,
                                    TaskState.FAILED.value) and t.priority_score is not None]
    failed_steps: dict[str, int] = {}
    for v in session.scalars(select(VerifyRecord).where(
            VerifyRecord.conclusion == "failed")).all():
        for step in v.step_results or []:
            if not step.get("passed"):
                failed_steps[step.get("action", "?")] = \
                    failed_steps.get(step.get("action", "?"), 0) + 1
    return {
        "tasks_total": len(tasks),
        "experience_total": session.scalar(select(func.count()).select_from(Experience)) or 0,
        "closed_avg_score": round(sum(closed_scores) / len(closed_scores), 2) if closed_scores else None,
        "failed_avg_score": round(sum(failed_scores) / len(failed_scores), 2) if failed_scores else None,
        "failed_step_distribution": failed_steps,
    }


def suggest_strategy(session: Session, current_weights: dict, current_threshold: float) -> dict:
    """生成评分策略优化建议（简化启发式，可解释）。

    规则：失败任务平均分高于通过任务 -> 准入过松，建议收紧阈值（下调 10%）。
    """
    stats = compute_stats(session)
    suggestion = {"weights": dict(current_weights), "threshold": current_threshold,
                  "reason": "样本不足，维持现状", "stats": stats}
    closed_avg, failed_avg = stats["closed_avg_score"], stats["failed_avg_score"]
    if closed_avg is not None and failed_avg is not None and failed_avg >= closed_avg:
        new_threshold = round(current_threshold * 0.9, 2)
        suggestion["threshold"] = new_threshold
        suggestion["reason"] = (
            f"失败任务平均分 {failed_avg} 不低于通过任务 {closed_avg}，"
            f"判定准入过松，建议阈值 {current_threshold} -> {new_threshold}")
    return suggestion


def create_optimization_intervention(session: Session, notifier,
                                     current_weights: dict,
                                     current_threshold: float) -> Intervention:
    """生成优化建议并创建「优化评审」介入单（批准后生效）。"""
    suggestion = suggest_strategy(session, current_weights, current_threshold)
    service = InterventionService(session, notifier)
    intervention = service.create(task_id=0, request=InterventionRequest(
        type="optimization",
        title="评分策略优化建议待评审",
        context={"suggestion": suggestion},
        assignee_role="tech_lead",
        wait_state=TaskState.MANUAL,  # 占位：优化评审不挂起具体任务
    ))
    # 优化评审不绑定具体任务：task_id 置空语义由 0 表示系统级
    AuditService(session).log(action="optimization_suggest",
                              target=f"intervention:{intervention.id}",
                              detail={"suggestion": {k: v for k, v in suggestion.items()
                                                     if k != "stats"}})
    return intervention


def apply_strategy(session: Session, intervention: Intervention, actor: str = "human") -> StrategyVersion:
    """批准生效：建议写入版本化策略表（停用旧版本）。"""
    suggestion = (intervention.result or {}).get("suggestion") or \
        (intervention.context or {}).get("suggestion") or {}
    weights = dict(suggestion.get("weights") or {})
    weights["threshold"] = suggestion.get("threshold")
    session.query(StrategyVersion).update({StrategyVersion.active: False})
    next_version = (session.scalar(select(func.max(StrategyVersion.version))) or 0) + 1
    version = StrategyVersion(
        version=next_version, weights=weights, active=True,
        source_intervention_id=intervention.id,
        note=f"由 {actor} 批准生效：{suggestion.get('reason', '')}")
    session.add(version)
    session.flush()
    AuditService(session).log(action="strategy_activate",
                              target=f"strategy_version:{version.id}",
                              detail={"version": version.version, "weights": weights,
                                      "actor": actor})
    return version


def rollback_strategy(session: Session, version: int, actor: str = "human") -> StrategyVersion:
    """回退到指定策略版本。"""
    target = session.scalar(select(StrategyVersion).where(StrategyVersion.version == version))
    if target is None:
        raise KeyError(f"策略版本不存在: {version}")
    session.query(StrategyVersion).update({StrategyVersion.active: False})
    target.active = True
    session.flush()
    AuditService(session).log(action="strategy_rollback",
                              target=f"strategy_version:{target.id}",
                              detail={"version": version, "actor": actor})
    return target
