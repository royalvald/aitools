"""数据库引擎与会话管理（SQLAlchemy 2.x，默认 SQLite）。"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from autobugfixer.common.core.config import get_settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    """所有 ORM 模型的声明式基类。"""


def make_engine(database_url: str | None = None):
    """按数据库 URL 创建引擎；SQLite 自动关闭同线程校验以适配多线程访问。"""
    url = database_url or get_settings().database_url
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    return create_engine(url, connect_args=connect_args)


def make_session_factory(engine=None) -> sessionmaker[Session]:
    """创建会话工厂；默认惰性建引擎，expire_on_commit=False 使提交后对象仍可用。"""
    return sessionmaker(bind=engine or make_engine(), expire_on_commit=False)


@contextmanager
def session_scope(factory: sessionmaker[Session]) -> Iterator[Session]:
    """简单的事务作用域：正常提交，异常回滚。"""
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def _add_missing_columns(engine) -> None:
    """轻量列补齐（无迁移框架的过渡方案）：create_all 只建表不加列，
    旧库按模型声明逐列 ALTER TABLE 补齐（新列均须可空，保证旧行兼容）。"""
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.tables.values():
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                col_type = col.type.compile(engine.dialect)
                try:
                    conn.execute(text(
                        f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col_type}"))
                except Exception as exc:  # best-effort：失败告警不阻断启动
                    logger.warning("补列失败 %s.%s: %s（可手工迁移或重建库）",
                                   table.name, col.name, exc)


def _migrate_legacy_bug_repo(engine) -> None:
    """旧 bug_repo（仓库事实挂行上）一次性迁移到全局 repo 表（best-effort）。

    旧库按 (path, branch) 归并建全局登记条目（画像择优继承、校验时间取最新），
    bug_repo 旧行补写 repo_id（origin=declared）。旧列保留在库中不再映射，
    重建库时自然消失；迁移失败仅告警不阻断（旧行作废，重新声明即重建）。
    """
    import json as _json

    insp = inspect(engine)
    if not (insp.has_table("repo") and insp.has_table("bug_repo")):
        return
    cols = {c["name"] for c in insp.get_columns("bug_repo")}
    if "repo_id" not in cols or "path" not in cols:
        return  # 新库（无旧列）或形状未知，跳过
    fetch_cols = ["id", "path", "branch", "is_git", "status", "fail_reason",
                  "checked_at", "profile"]
    fetch_cols = [c for c in fetch_cols if c in cols]
    with engine.begin() as conn:
        rows = conn.execute(text(
            f"SELECT {', '.join(fetch_cols)} FROM bug_repo "
            "WHERE repo_id IS NULL AND path IS NOT NULL AND path != ''"
        )).mappings().all()
        if not rows:
            return
        # (path, branch) -> 归并事实（最新 checked_at 优先，画像取任一非空）
        merged: dict[tuple[str, str], dict] = {}
        for r in rows:
            key = (r["path"], r["branch"] or "main")
            cur = merged.get(key)
            if cur is None or (r["checked_at"] or "") > (cur["checked_at"] or ""):
                base = dict(r)
                base["branch"] = key[1]
                if cur is not None and not base.get("profile"):
                    base["profile"] = cur.get("profile")
                merged[key] = base
            elif r.get("profile") and not merged[key].get("profile"):
                merged[key]["profile"] = r["profile"]
        for (path, branch), facts in merged.items():
            rid = conn.execute(text(
                "SELECT id FROM repo WHERE path = :p AND branch = :b"),
                {"p": path, "b": branch}).scalar()
            if rid is None:
                profile = facts.get("profile")
                profile_text = profile if isinstance(profile, str) else (
                    _json.dumps(profile, ensure_ascii=False) if profile else None)
                conn.execute(text(
                    "INSERT INTO repo (path, branch, is_git, status, fail_reason,"
                    " checked_at, profile, profiled_at, source, created_at, updated_at)"
                    " VALUES (:p, :b, :g, :st, :fr, :ca, :pr,"
                    " CASE WHEN :pr IS NULL THEN NULL ELSE :ca END,"
                    " 'migrated', :ca, :ca)"),
                    {"p": path, "b": branch, "g": int(bool(facts.get("is_git"))),
                     "st": facts.get("status") or "unavailable",
                     "fr": facts.get("fail_reason") or "",
                     "ca": facts.get("checked_at"),
                     "pr": profile_text})
                rid = conn.execute(text(
                    "SELECT id FROM repo WHERE path = :p AND branch = :b"),
                    {"p": path, "b": branch}).scalar()
        for r in rows:
            key = (r["path"], r["branch"] or "main")
            facts = merged[key]
            conn.execute(text(
                "UPDATE bug_repo SET repo_id = (SELECT id FROM repo"
                " WHERE path = :p AND branch = :b), origin = 'declared'"
                " WHERE id = :id"),
                {"p": key[0], "b": key[1], "id": r["id"]})
        logger.info("bug_repo 旧数据迁移完成: %s 行 -> %s 个全局仓库",
                    len(rows), len(merged))


def init_db(engine=None) -> None:
    """建表：导入 models 触发表注册后执行 create_all（幂等），再补齐旧库缺失列。"""
    from . import models  # noqa: F401 确保表已注册

    engine = engine or make_engine()
    Base.metadata.create_all(engine)
    _add_missing_columns(engine)
    _migrate_legacy_bug_repo(engine)
