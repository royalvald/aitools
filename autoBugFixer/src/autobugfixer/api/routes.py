"""API 路由（设计文档 6.1 对内接口）。"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select

from autobugfixer.common.core.models import (
    BugTicket,
    FixRecord,
    Intervention,
    Task,
    TaskStateHistory,
    VerificationPlan,
    VerifyRecord,
)
from autobugfixer.common.core.state import TaskState
from autobugfixer.features.knowledge.experience import ExperienceService
from autobugfixer.features.ingest.ingestion import ingest_bug
from autobugfixer.features.intervention.service import InterventionService

router = APIRouter()


# ---------- 健康检查 ----------

@router.get("/health")
def health(request: Request):
    """健康检查：服务存活 + LLM/codex 预检状态（失败时 status=degraded，Spec 02 B0 / Spec 05）。"""
    report = getattr(request.app.state, "llm_preflight", None)
    codex_errors = getattr(request.app.state, "codex_preflight", None)
    if report is None:
        return {"status": "ok", "llm": {"mode": "unknown", "probe": "unknown"},
                "codex": {"status": "unknown"}}
    return {
        "status": "ok" if report.ok else "degraded",
        "llm": {"mode": report.mode,
                "probe": "ok" if not report.probe_error else report.probe_error},
        "codex": {"status": "ok" if not codex_errors else "error",
                  "detail": codex_errors or []},
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
    """人工重新触发（统一走 transition_task：校验 + 历史 + 审计 + 回写）。

    - FAILED：按崩溃时所在阶段断点续跑（fixing→FIXING、deploying/verifying→DEPLOYING、
      learning→LEARNING，其余→ANALYZING 重跑预处理），不再一律回分析重烧 LLM；
    - MANUAL：人工重新触发进入 ANALYZING（激活设计承诺的"可人工重新触发"）；
    - WAIT_ENV：直接唤醒尝试部署；
    - 其余阻塞/终态：不迁移不驱动，返回当前状态。

    驱动策略：ANALYZING 目标只跑预处理（停在 SCORED 等调度器，受 admission_hold
    与派发上限约束）；FIXING/DEPLOYING/LEARNING 为人工显式续跑，同步推进。
    """
    from autobugfixer.common.core.transitions import transition_task

    sf = request.app.state.session_factory
    orchestrator = request.app.state.orchestrator
    target: TaskState | None = None
    with sf() as s:
        task = s.get(Task, task_id)
        if task is None:
            raise HTTPException(404, f"任务不存在: {task_id}")
        state = TaskState(task.state)
        if state == TaskState.FAILED:
            stage = (task.current_stage or "").lower()
            if stage in ("deploying", "verifying"):
                target = TaskState.DEPLOYING
            elif stage == "fixing":
                target = TaskState.FIXING
            elif stage == "learning":
                target = TaskState.LEARNING
            else:
                target = TaskState.ANALYZING
        elif state == TaskState.MANUAL:
            target = TaskState.ANALYZING
        elif state == TaskState.WAIT_ENV:
            target = TaskState.DEPLOYING
        if target is not None:
            message = {
                TaskState.ANALYZING: "人工重新触发，重跑预处理",
                TaskState.FIXING: "人工重新触发，从修复续跑",
                TaskState.DEPLOYING: "人工重新触发，从部署续跑",
                TaskState.LEARNING: "人工重新触发，从经验沉淀续跑",
            }.get(target, "人工重新触发")
            transition_task(s, task, target, stage="api", message=message)
        s.commit()
    if target == TaskState.ANALYZING:
        final = orchestrator.run_preprocessing(task_id)
    elif target in (TaskState.FIXING, TaskState.DEPLOYING, TaskState.LEARNING):
        final = orchestrator.run_until_blocked(task_id)
    else:
        final = orchestrator._state_of(task_id)
    return {"task_id": task_id, "state": final.value}


@router.post("/tasks/{task_id}/cancel")
def cancel_task(request: Request, task_id: int):
    """人工取消任务（激活 CANCELLED 终态）：关闭待办介入单并释放持有的环境锁。"""
    from autobugfixer.adapters.env.lock import EnvLockService
    from autobugfixer.common.core.transitions import transition_task

    sf = request.app.state.session_factory
    settings = request.app.state.settings
    with sf() as s:
        task = s.get(Task, task_id)
        if task is None:
            raise HTTPException(404, f"任务不存在: {task_id}")
        if task.state in (TaskState.CLOSED.value, TaskState.CANCELLED.value):
            raise HTTPException(409, f"任务已是终态: {task.state}")
        transition_task(s, task, TaskState.CANCELLED, stage="api", message="人工取消")
        for it in s.scalars(select(Intervention).where(
                Intervention.task_id == task_id,
                Intervention.status == "pending")).all():
            it.status = "cancelled"
            it.result = {"note": "任务已人工取消，介入单自动关闭"}
            it.resolved_at = datetime.now(timezone.utc)
        if task.environment_id is not None:
            EnvLockService(s, lease_seconds=settings.env_lock_lease_seconds).release(
                task.environment_id, task_id)
        s.commit()
    return {"task_id": task_id, "state": TaskState.CANCELLED.value}


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
    """平台事件接入（安全唤醒语义）：

    - 入库/刷新/唤醒仍由 ``ingest_bug`` 幂等完成；
    - 仅当任务停在 ANALYZING（新接入或平台补全唤醒）时推进**预处理**
      （停在 SCORED 等调度器按优先级出队，受 admission_hold 与派发上限约束）；
    - 不再无条件 ``run_until_blocked``：SCORED 任务不插队、in-flight 任务
      （FIXING/DEPLOYING/VERIFYING/LEARNING）不被第二个执行者并发驱动。
    """
    from autobugfixer.adapters.platform import BugTicketData

    payload = await request.json()
    sf = request.app.state.session_factory
    data = BugTicketData(platform=platform, **payload)
    platform_adapter = request.app.state.orchestrator.platform
    if hasattr(platform_adapter, "upsert_bug"):  # Mock 平台同步事件数据
        platform_adapter.upsert_bug(data)
    with sf() as s:
        task, created = ingest_bug(s, data, max_retry=request.app.state.settings.max_retry)
        s.commit()
        task_id, state = task.id, TaskState(task.state)
    if state == TaskState.ANALYZING:
        state = request.app.state.orchestrator.run_preprocessing(task_id)
    return {"task_id": task_id, "created": created, "state": state.value}


# ---------- CSV 导入 ----------

@router.post("/import/csv")
async def import_csv(request: Request,
                     file: UploadFile = File(...),
                     platform: str = Form("csv"),
                     run_analysis: bool = Form(False)):
    """CSV 批量导入（multipart 上传）；run_analysis=true 时附带预处理分析结果。"""
    from autobugfixer.features.ingest.csv_import import CsvFormatError, parse_csv
    from autobugfixer.features.ingest.importer import analyze_tasks, import_bug_rows

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
    """指标口径（设计 11.7，按状态历史判定而非按当前态近似）：

    - 自动修复成功率 = 无需人工介入到达 CLOSED 的任务 / 进入 SCORED 的任务总数；
      分母取 TaskStateHistory 中 to_state=SCORED 的去重任务（预处理期转出的
      MANUAL/WAIT_* 不计入），分子剔除经人工介入（补充/确认/讨论）的任务；
    - 回归通过率 = 首次验证通过任务 / 完成首次验证任务；"首次"按每任务
      最早 VerifyRecord（id 最小）判定——人工重试重置 attempt 后不再误计；
    - 知识库复用率 = 命中经验的修复任务 / 进入 FIXING 的任务总数（历史判定）。
    """
    sf = request.app.state.session_factory
    with sf() as s:
        tasks = s.scalars(select(Task)).all()
        entered_scored = set(s.scalars(select(TaskStateHistory.task_id).where(
            TaskStateHistory.to_state == TaskState.SCORED.value).distinct()).all())
        entered_fixing = set(s.scalars(select(TaskStateHistory.task_id).where(
            TaskStateHistory.to_state == TaskState.FIXING.value).distinct()).all())
        # 人工介入过的任务（平台侧自动唤醒关闭的介入单不计为人工）
        human_touched = {it.task_id for it in s.scalars(select(Intervention).where(
            Intervention.status.in_(["resolved", "timeout"]),
            Intervention.type.in_(["info_supplement", "repo_supplement",
                                   "plan_confirm", "discussion"]))).all()
            if (it.result or {}).get("fields") != "platform_sync"}
        closed = [t for t in tasks if t.state == TaskState.CLOSED.value]
        closed_auto = [t for t in closed if t.id not in human_touched]
        # 首次验证 = 每任务最早（id 最小）的 VerifyRecord
        first_verify: dict[int, VerifyRecord] = {}
        for v in s.scalars(select(VerifyRecord).order_by(VerifyRecord.id)).all():
            first_verify.setdefault(v.task_id, v)
        first_total = len(first_verify)
        first_pass = sum(1 for v in first_verify.values() if v.conclusion == "passed")
        # 平均修复周期：CLOSED 任务的 closed_at - created_at 均值（分钟）
        durations = []
        for t in closed:
            if t.closed_at and t.created_at:
                end, start = t.closed_at, t.created_at
                if end.tzinfo is None and start.tzinfo is not None:
                    start = start.replace(tzinfo=None)
                durations.append((end - start).total_seconds() / 60)
        avg_duration = round(sum(durations) / len(durations), 2) if durations else None
        fixes = s.scalars(select(FixRecord)).all()
        hit_tasks = {f.task_id for f in fixes if f.experience_hit}
        return {
            "auto_fix_rate": len(closed_auto) / len(entered_scored) if entered_scored else 0.0,
            "first_verify_pass_rate": first_pass / first_total if first_total else 0.0,
            "avg_fix_duration_minutes": avg_duration,
            "knowledge_reuse_rate": len(hit_tasks) / len(entered_fixing) if entered_fixing else 0.0,
            "tasks_total": len(tasks),
        }


@router.get("/experiences/export")
def export_experiences(request: Request, format: str = "markdown"):
    """知识库沉淀输出（FR-SYS-03）：经验库导出为 Markdown（导出前脱敏）。"""
    from fastapi.responses import PlainTextResponse

    from autobugfixer.features.knowledge.export import render_markdown

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
