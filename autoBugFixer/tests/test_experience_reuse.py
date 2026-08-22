"""经验复用回路测试（FR-MEM-01 闭环）：检索注入 + 命中计数 + 沉淀去重。"""

import pytest
from sqlalchemy import select

from autobugfixer.platform import BugTicketData
from autobugfixer.core.models import Experience, FixRecord
from autobugfixer.core.state import TaskState
from autobugfixer.knowledge.experience import ExperienceService
from autobugfixer.ingest.ingestion import ingest_bug


def test_experience_injected_into_fix_prompt(make_orchestrator, task_id,
                                             session_factory, environment):
    # 预置一条标题关键词可命中的经验
    with session_factory() as s:
        ExperienceService(s).save(
            category="接口类", problem_signature="健康检查接口返回错误",
            symptoms="status=fail", fix_pattern="将 health.json 的 status 改为 ok",
            source_task_ids=[999])
        s.commit()

    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED

    with session_factory() as s:
        fix = s.scalar(select(FixRecord).where(FixRecord.task_id == task_id))
        assert fix.experience_hit is True
        assert "历史修复经验" in fix.prompt_snapshot
        exp = s.scalar(select(Experience).where(
            Experience.problem_signature == "健康检查接口返回错误"))
        assert exp.hit_count == 1


def test_experience_upsert_dedup(make_orchestrator, session_factory, platform,
                                 settings, environment):
    """同 category + problem_signature 沉淀时合并更新而非重复新增。"""
    orchestrator = make_orchestrator()
    bug = platform.list_bugs()[0]
    for _ in range(2):  # 同一条 Bug 跑两次（模拟同类问题反复修复）
        data = BugTicketData(**{**bug.model_dump(),
                                "platform_bug_id": bug.platform_bug_id})
        with session_factory() as s:
            task, created = ingest_bug(s, data)
            if not created:  # 幂等去重 -> 手工复制一条新任务
                from autobugfixer.core.models import Task
                task = Task(bug_ticket_id=task.bug_ticket_id, state="ANALYZING",
                            max_retry=settings.max_retry)
                s.add(task)
                s.flush()
            s.commit()
            task_id = task.id
        orchestrator.run_until_blocked(task_id)

    with session_factory() as s:
        entries = s.scalars(select(Experience).where(
            Experience.problem_signature == bug.title)).all()
        assert len(entries) == 1
        assert entries[0].version == 2  # 第二次合并更新
        assert len(entries[0].source_task_ids) == 2


def test_experience_active_unique_constraint(session_factory):
    """Spec 08 §7：活跃条目 (category, problem_signature) 唯一索引防并发重复插入。"""
    from sqlalchemy.exc import IntegrityError

    with session_factory() as s:
        ExperienceService(s).save(category="接口类", problem_signature="重复入账")
        s.commit()
        with pytest.raises(IntegrityError):
            ExperienceService(s).save(category="接口类", problem_signature="重复入账")
            s.commit()
