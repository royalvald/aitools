"""数据库引擎与会话管理（SQLAlchemy 2.x，默认 SQLite）。"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings


class Base(DeclarativeBase):
    pass


def make_engine(database_url: str | None = None):
    url = database_url or get_settings().database_url
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    return create_engine(url, connect_args=connect_args)


def make_session_factory(engine=None) -> sessionmaker[Session]:
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


def init_db(engine=None) -> None:
    from . import models  # noqa: F401 确保表已注册

    Base.metadata.create_all(engine or make_engine())
