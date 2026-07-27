"""环境锁互斥与租约过期测试（11.1）。"""

from datetime import datetime, timedelta, timezone

from autobugfixer.models import Environment, EnvLock
from autobugfixer.services.env_lock import EnvLockService


def _make_env(session_factory) -> int:
    with session_factory() as s:
        env = Environment(name="env-lock-test", type="local")
        s.add(env)
        s.commit()
        return env.id


def test_lock_mutual_exclusion(session_factory):
    env_id = _make_env(session_factory)
    with session_factory() as s:
        locks = EnvLockService(s, lease_seconds=60)
        assert locks.acquire(env_id, task_id=1) is True
        assert locks.acquire(env_id, task_id=2) is False   # 互斥：被任务 1 持有
        assert locks.acquire(env_id, task_id=1) is True    # 重入幂等
        assert locks.release(env_id, task_id=2) is False   # 非持锁人不能释放
        assert locks.release(env_id, task_id=1) is True
        assert locks.acquire(env_id, task_id=2) is True    # 释放后可取


def test_lock_lease_expiry(session_factory):
    env_id = _make_env(session_factory)
    with session_factory() as s:
        # 伪造一把已过期的锁（模拟 worker 崩溃遗留）
        s.add(EnvLock(env_id=env_id, holder_task_id=99,
                      expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
        s.commit()
        locks = EnvLockService(s, lease_seconds=60)
        assert locks.acquire(env_id, task_id=2) is True  # 过期锁被回收后可取
        s.commit()


def test_release_expired_batch(session_factory):
    env_id = _make_env(session_factory)
    with session_factory() as s:
        s.add(EnvLock(env_id=env_id, holder_task_id=99,
                      expires_at=datetime.now(timezone.utc) - timedelta(seconds=10)))
        s.commit()
        released = EnvLockService(s).release_expired()
        assert released == [env_id]
        assert EnvLockService(s).acquire(env_id, task_id=1) is True


def test_lock_renew(session_factory):
    env_id = _make_env(session_factory)
    with session_factory() as s:
        locks = EnvLockService(s, lease_seconds=60)
        locks.acquire(env_id, task_id=1)
        assert locks.renew(env_id, task_id=1) is True
        assert locks.renew(env_id, task_id=2) is False  # 非持锁人不能续期
