"""环境锁服务（设计文档 11.1）。

- environment_id 粒度互斥，数据库行实现，不依赖外部组件；
- 锁定范围：DEPLOYING 开始持锁，VERIFYING 结束释放（部署+验证为临界区）；
- 租约防死锁：到期自动失效，调度器回收后任务可重跑（Stage 幂等）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from autobugfixer.common.core.models import EnvLock


class EnvLockService:
    """环境锁服务（DB 行实现，带租约的互斥锁）。"""

    def __init__(self, session: Session, lease_seconds: int = 1800) -> None:
        self.session = session
        self.lease_seconds = lease_seconds

    def _get(self, env_id: int) -> EnvLock | None:
        return self.session.scalar(select(EnvLock).where(EnvLock.env_id == env_id))

    @staticmethod
    def _expired(lock: EnvLock, now: datetime) -> bool:
        expires = lock.expires_at
        if expires.tzinfo is None:  # SQLite 读回为 naive，按 UTC 处理
            expires = expires.replace(tzinfo=timezone.utc)
        return expires <= now

    def acquire(self, env_id: int, task_id: int) -> bool:
        """尝试取锁：未被持有、或租约已过期、或本来就是自己持有，则成功。

        冲突回滚走 SAVEPOINT（begin_nested）：只撤销锁行插入，不波及同一
        事务里调用方已写入的任务字段（如 task.environment_id，P0-4——
        此前整事务 rollback 会把任务永久卡死 WAIT_ENV 且无人唤醒）。
        """
        now = datetime.now(timezone.utc)
        lock = self._get(env_id)
        if lock is not None:
            if lock.holder_task_id == task_id:
                return True  # 重入：幂等
            if not self._expired(lock, now):
                return False  # 被其他任务有效持有
            self.session.delete(lock)  # 过期锁回收
            self.session.flush()
        try:
            with self.session.begin_nested():  # SAVEPOINT：仅覆盖锁行插入
                self.session.add(EnvLock(
                    env_id=env_id, holder_task_id=task_id,
                    expires_at=now + timedelta(seconds=self.lease_seconds),
                ))
                self.session.flush()
            return True
        except IntegrityError:
            return False  # SAVEPOINT 已回滚，事务内其余改动保持完好

    def renew(self, env_id: int, task_id: int) -> bool:
        """续期租约。"""
        lock = self._get(env_id)
        if lock is None or lock.holder_task_id != task_id:
            return False
        lock.expires_at = datetime.now(timezone.utc) + timedelta(seconds=self.lease_seconds)
        self.session.flush()
        return True

    def release(self, env_id: int, task_id: int) -> bool:
        """释放锁（只有持锁人能释放）。"""
        lock = self._get(env_id)
        if lock is None or lock.holder_task_id != task_id:
            return False
        self.session.delete(lock)
        self.session.flush()
        return True

    def release_expired(self) -> list[int]:
        """超时回收：释放全部租约过期的锁，返回 env_id 列表。"""
        now = datetime.now(timezone.utc)
        released = []
        for lock in self.session.scalars(select(EnvLock)).all():
            if self._expired(lock, now):
                released.append(lock.env_id)
                self.session.delete(lock)
        self.session.flush()
        return released
