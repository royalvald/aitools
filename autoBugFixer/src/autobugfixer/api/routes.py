"""API 路由（设计文档 6.1 对内接口）。"""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select

from ..models import (
    BugTicket,
    FixRecord,
    Intervention,
    Task,
    TaskStateHistory,
    VerificationPlan,
    VerifyRecord,
)
from ..pipeline.state import TaskState
from ..services.experience import ExperienceService
from ..services.ingestion import ingest_bug
from ..services.intervention import InterventionService

router = APIRouter()


# ---------- 健康检查 ----------

@router.get("/health")
def health(request: Request):
    """健康检查：服务存活 + LLM 预检状态（探测失败时 status=degraded，Spec 02 B0）。"""
    report = getattr(request.app.state, "llm_preflight", None)
    if report is None:
        return {"status": "ok", "llm": {"mode": "unknown", "probe": "unknown"}}
    return {
        "status": "ok" if report.ok else "degraded",
        "llm": {"mode": report.mode,
                "probe": "ok" if not report.probe_error else report.probe_error},
    }


# ---------- 任务 ----------

@router.get("/tasks")
def list_tasks(request: Request, state: str | None = None, page: int = 1, size: int = 20):
    """任务看板分页查询（按优先级升序，可按状态过滤）。"""
    sf = request.app.state.session_factory
    with sf() as s:
        stmt = select(Task).order_by(Task.priority_score.asc().nulls_last(), Task.id)
        if state:
            stmt = stmt.where(Task.state == state)
        total = s.scalar(select(func.count()).select_from(stmt.subquery()))
        tasks = s.scalars(stmt.offset((page - 1) * size).limit(size)).all()
        titles = _bug_titles(s, [t.bug_ticket_id for t in tasks])
        return {"total": total, "page": page,
                "items": [_task_brief(t, titles.get(t.bug_ticket_id, "")) for t in tasks]}


@router.get("/tasks/{task_id}")
def task_detail(request: Request, task_id: int):
    """任务详情：评分明细、状态时间线、方案/修复/验证记录。"""
    sf = request.app.state.session_factory
    with sf() as s:
        task = s.get(Task, task_id)
        if task is None:
            raise HTTPException(404, f"任务不存在: {task_id}")
        timeline = s.scalars(select(TaskStateHistory).where(
            TaskStateHistory.task_id == task_id).order_by(TaskStateHistory.id)).all()
        plans = s.scalars(select(VerificationPlan).where(
            VerificationPlan.task_id == task_id)).all()
        fixes = s.scalars(select(FixRecord).where(FixRecord.task_id == task_id)).all()
        verifies = s.scalars(select(VerifyRecord).where(VerifyRecord.task_id == task_id)).all()
        bug = s.get(BugTicket, task.bug_ticket_id)
        return {
            **_task_brief(task, bug.title if bug else ""),
            "score_detail": task.score_detail,
            "timeline": [{"from": h.from_state, "to": h.to_state, "stage": h.stage,
                          "message": h.message, "at": str(h.created_at)} for h in timeline],
            "plans": [{"id": p.id, "version": p.version, "risk_level": p.risk_level,
                       "steps": p.steps} for p in plans],
            "fix_records": [{"id": f.id, "attempt": f.attempt, "branch": f.branch,
                             "changed_files": f.changed_files, "summary": f.summary}
                            for f in fixes],
            "verify_records": [{"id": v.id, "attempt": v.attempt, "conclusion": v.conclusion,
                                "step_results": v.step_results} for v in verifies],
        }


@router.post("/tasks/{task_id}/retry")
def retry_task(request: Request, task_id: int):
    """人工重新触发：从断点续跑（FAILED/WAIT_ENV/阻塞解除后继续流转）。"""
    sf = request.app.state.session_factory
    orchestrator = request.app.state.orchestrator
    with sf() as s:
        task = s.get(Task, task_id)
        if task is None:
            raise HTTPException(404, f"任务不存在: {task_id}")
        state = TaskState(task.state)
        if state == TaskState.FAILED:
            task.state = TaskState.ANALYZING.value  # 回到分析阶段重跑
            s.add(TaskStateHistory(task_id=task_id, from_state=state.value,
                                   to_state=TaskState.ANALYZING.value,
                                   stage="api", message="人工重新触发"))
        elif state == TaskState.WAIT_ENV:
            task.state = TaskState.DEPLOYING.value
            s.add(TaskStateHistory(task_id=task_id, from_state=state.value,
                                   to_state=TaskState.DEPLOYING.value,
                                   stage="api", message="人工唤醒等锁任务"))
        s.commit()
    final = orchestrator.run_until_blocked(task_id)
    return {"task_id": task_id, "state": final.value}


# ---------- 介入 ----------

@router.get("/interventions")
def list_interventions(request: Request, assignee: str | None = None,
                       status: str = "pending"):
    """介入单列表查询（可按角色与状态过滤）。"""
    sf = request.app.state.session_factory
    with sf() as s:
        stmt = select(Intervention).where(Intervention.status == status)
        if assignee:
            stmt = stmt.where(Intervention.assignee_role == assignee)
        items = s.scalars(stmt.order_by(Intervention.id)).all()
        return {"items": [{"id": i.id, "task_id": i.task_id, "type": i.type, "title": i.title,
                           "assignee_role": i.assignee_role, "status": i.status,
                           "deadline": str(i.deadline) if i.deadline else None,
                           "context": i.context} for i in items]}


class ResolveBody(BaseModel):
    result: dict
    actor: str = "human"


@router.post("/interventions/{intervention_id}/resolve")
def resolve_intervention(request: Request, intervention_id: int, body: ResolveBody):
    """介入处理回写：写结果并驱动任务续跑。"""
    sf = request.app.state.session_factory
    orchestrator = request.app.state.orchestrator
    with sf() as s:
        service = InterventionService(s, request.app.state.orchestrator.notifier)
        try:
            task = service.resolve(intervention_id, body.result, actor=body.actor)
        except KeyError as exc:
            raise HTTPException(404, str(exc))
        except ValueError as exc:
            raise HTTPException(409, str(exc))
        s.commit()
    if task is None:  # 系统级介入单（如优化评审），不驱动任务
        return {"intervention_id": intervention_id, "task_id": None, "task_state": None}
    final = orchestrator.run_until_blocked(task.id)
    return {"intervention_id": intervention_id, "task_id": task.id, "task_state": final.value}


# ---------- webhook（缺陷平台事件接入） ----------

@router.post("/webhooks/{platform}")
async def platform_webhook(request: Request, platform: str):
    """平台事件接入：payload 为 Bug 字段字典，标准化入库并触发流水线。"""
    from ..adapters.bug_platform import BugTicketData

    payload = await request.json()
    sf = request.app.state.session_factory
    data = BugTicketData(platform=platform, **payload)
    platform_adapter = request.app.state.orchestrator.platform
    if hasattr(platform_adapter, "upsert_bug"):  # Mock 平台同步事件数据
        platform_adapter.upsert_bug(data)
    with sf() as s:
        task, created = ingest_bug(s, data, max_retry=request.app.state.settings.max_retry)
        s.commit()
        task_id = task.id
    final = request.app.state.orchestrator.run_until_blocked(task_id)
    return {"task_id": task_id, "created": created, "state": final.value}


# ---------- CSV 导入 ----------

@router.post("/import/csv")
async def import_csv(request: Request,
                     file: UploadFile = File(...),
                     platform: str = Form("csv"),
                     run_analysis: bool = Form(False)):
    """CSV 批量导入（multipart 上传）；run_analysis=true 时附带预处理分析结果。"""
    from ..adapters.csv_import import CsvFormatError, parse_csv
    from ..services.importer import analyze_tasks, import_bug_rows

    content = await file.read()
    try:
        parsed = parse_csv(content, platform=platform)
    except CsvFormatError as exc:
        raise HTTPException(400, f"CSV 格式错误: {exc}")

    sf = request.app.state.session_factory
    settings = request.app.state.settings
    with sf() as s:
        result = import_bug_rows(s, parsed, platform=platform,
                                 max_retry=settings.max_retry,
                                 source=file.filename or "upload")
        s.commit()
    if run_analysis and result["task_ids"]:
        result["analysis"] = analyze_tasks(
            request.app.state.orchestrator, sf, result["task_ids"])
    return result


# ---------- 指标与经验库 ----------

@router.get("/metrics/summary")
def metrics_summary(request: Request):
    """指标口径见设计文档 11.7。"""
    sf = request.app.state.session_factory
    with sf() as s:
        tasks = s.scalars(select(Task)).all()
        scored = [t for t in tasks if TaskState(t.state) not in
                  (TaskState.DISCOVERED, TaskState.ANALYZING, TaskState.WAIT_INFO,
                   TaskState.PLANNING, TaskState.WAIT_PLAN)]
        closed_auto = [t for t in tasks if t.state == TaskState.CLOSED.value]
        verifies = s.scalars(select(VerifyRecord)).all()
        first_pass = len({v.task_id for v in verifies if v.attempt == 1
                          and v.conclusion == "passed"})
        first_total = len({v.task_id for v in verifies if v.attempt == 1})
        # 平均修复周期：CLOSED 任务的 closed_at - created_at 均值（分钟）
        durations = []
        for t in closed_auto:
            if t.closed_at and t.created_at:
                end, start = t.closed_at, t.created_at
                if end.tzinfo is None and start.tzinfo is not None:
                    start = start.replace(tzinfo=None)
                durations.append((end - start).total_seconds() / 60)
        avg_duration = round(sum(durations) / len(durations), 2) if durations else None
        # 知识库复用率：修复指令命中经验条目的任务数 / 进入 FIXING 的任务数
        fixes = s.scalars(select(FixRecord)).all()
        fix_tasks = {f.task_id for f in fixes}
        hit_tasks = {f.task_id for f in fixes if f.experience_hit}
        return {
            "auto_fix_rate": len(closed_auto) / len(scored) if scored else 0.0,
            "first_verify_pass_rate": first_pass / first_total if first_total else 0.0,
            "avg_fix_duration_minutes": avg_duration,
            "knowledge_reuse_rate": len(hit_tasks) / len(fix_tasks) if fix_tasks else 0.0,
            "tasks_total": len(tasks),
        }


@router.get("/experiences/export")
def export_experiences(request: Request, format: str = "markdown"):
    """知识库沉淀输出（FR-SYS-03）：经验库导出为 Markdown（导出前脱敏）。"""
    from fastapi.responses import PlainTextResponse

    from ..services.export import render_markdown

    if format != "markdown":
        raise HTTPException(400, f"暂不支持的导出格式: {format}")
    sf = request.app.state.session_factory
    with sf() as s:
        return PlainTextResponse(render_markdown(s), media_type="text/markdown; charset=utf-8")


@router.get("/experiences")
def list_experiences(request: Request, category: str | None = None, q: str | None = None):
    """经验库检索（按分类或关键词）。"""
    sf = request.app.state.session_factory
    with sf() as s:
        items = ExperienceService(s).search(category=category, q=q)
        return {"items": [{"id": e.id, "category": e.category,
                           "problem_signature": e.problem_signature,
                           "fix_pattern": e.fix_pattern, "hit_count": e.hit_count,
                           "verification_points": e.verification_points,
                           "applicable_conditions": e.applicable_conditions}
                          for e in items]}


def _bug_titles(s, bug_ids: list[int]) -> dict[int, str]:
    if not bug_ids:
        return {}
    return {b.id: b.title for b in s.scalars(
        select(BugTicket).where(BugTicket.id.in_(bug_ids))).all()}


def _task_brief(t: Task, title: str = "") -> dict:
    return {"id": t.id, "bug_ticket_id": t.bug_ticket_id, "title": title, "state": t.state,
            "priority_score": t.priority_score, "retry_count": t.retry_count,
            "current_stage": t.current_stage, "created_at": str(t.created_at),
            "updated_at": str(t.updated_at)}
