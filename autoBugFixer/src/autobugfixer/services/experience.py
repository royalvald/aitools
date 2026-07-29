"""经验库服务（FR-MEM-01 简化版：分类入库 + 关键词检索）。

P1 的比对去重 / 向量检索只留接口占位，不实现。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Experience


class ExperienceService:
    """经验库服务：分类入库、比对去重、检索复用。"""

    def __init__(self, session: Session) -> None:
        self.session = session

    def save(self, *, category: str, problem_signature: str, symptoms: str = "",
             root_cause_pattern: str = "", fix_pattern: str = "",
             verification_points: str = "", applicable_conditions: str = "",
             source_task_ids: list[int] | None = None) -> Experience:
        """新增一条经验条目（不做去重，直接落库）。"""
        entry = Experience(
            category=category, problem_signature=problem_signature, symptoms=symptoms,
            root_cause_pattern=root_cause_pattern, fix_pattern=fix_pattern,
            verification_points=verification_points,
            applicable_conditions=applicable_conditions,
            source_task_ids=source_task_ids or [],
        )
        self.session.add(entry)
        self.session.flush()
        return entry

    def upsert(self, *, category: str, problem_signature: str, **kwargs) -> Experience:
        """比对去重（FR-MEM-01）：同 category + problem_signature 合并更新，否则新增。"""
        existing = self.session.scalar(select(Experience).where(
            Experience.category == category,
            Experience.problem_signature == problem_signature,
            Experience.status == "active"))
        if existing is None:
            return self.save(category=category, problem_signature=problem_signature, **kwargs)
        for key in ("symptoms", "root_cause_pattern", "fix_pattern",
                    "verification_points", "applicable_conditions"):
            value = kwargs.get(key)
            if value:
                setattr(existing, key, value)  # 合并修正：以最新经验为准
        for task_id in kwargs.get("source_task_ids") or []:
            if task_id not in (existing.source_task_ids or []):
                existing.source_task_ids = (existing.source_task_ids or []) + [task_id]
        existing.version += 1
        self.session.flush()
        return existing

    def find_relevant(self, *, modules: list[str] | None = None,
                      keywords: list[str] | None = None, limit: int = 3) -> list[Experience]:
        """修复前检索（复用回路）：模块/关键词结构化匹配，命中供注入修复指令。"""
        entries = list(self.session.scalars(
            select(Experience).where(Experience.status == "active")).all())
        keys = [k for k in (keywords or []) if k]
        mods = [m for m in (modules or []) if m]
        hits = [
            e for e in entries
            if any(m in e.problem_signature or m in e.applicable_conditions for m in mods)
            or any(k in e.problem_signature or k in e.symptoms for k in keys)
        ]
        return hits[:limit]

    def search(self, category: str | None = None, q: str | None = None) -> list[Experience]:
        """结构化字段 + 关键词检索（P1：全文索引/向量检索后置）。"""
        stmt = select(Experience).where(Experience.status == "active")
        if category:
            stmt = stmt.where(Experience.category == category)
        if q:
            stmt = stmt.where(Experience.problem_signature.contains(q))
        return list(self.session.scalars(stmt).all())

    def hit(self, experience_id: int) -> None:
        """复用回路：修复指令命中经验条目时累计命中次数。"""
        entry = self.session.get(Experience, experience_id)
        if entry is not None:
            entry.hit_count += 1
            self.session.flush()
