"""环境锁互斥与租约过期测试（11.1）。"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from autobugfixer.adapters.bug_platform import BugTicketData
from autobugfixer.models import Environment, EnvLock, VerificationPlan
from autobugfixer.pipeline.state import TaskState
from autobugfixer.services.env_lock import EnvLockService
from autobugfixer.services.ingestion import ingest_bug


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


def test_deploy_failure_releases_env_lock(make_orchestrator, session_factory,
                                          settings, repo):
    """部署失败回滚后环境锁必须立即释放（异常路径不泄漏临界区）。"""
    with session_factory() as s:
        env = Environment(name="broken-env", type="local",
                          deploy_script=["false"], cmd_whitelist=["false"])
        s.add(env)
        s.commit()
        env_id = env.id

    data = BugTicketData(platform_bug_id="BUG-LK1", title="健康检查接口返回 fail",
                         description="描述", repro_steps="1. 复现", expected="ok",
                         actual="fail", env_version="v1",
                         repo_url=str(repo), affected_modules=["web"])
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        task_id = task.id

    final = make_orchestrator().run_until_blocked(task_id)
    assert final == TaskState.FAILED
    with session_factory() as s:
        assert s.scalar(select(EnvLock)) is None  # 部署失败已释放锁
        # 环境立即可被其他任务获取，无需等租约过期
        assert EnvLockService(s, lease_seconds=60).acquire(env_id, task_id=999) is True


def test_verify_exception_releases_env_lock(make_orchestrator, session_factory,
                                            settings, repo, environment):
    """验证阶段异常（方案损坏）转 FAILED 时环境锁同样释放。"""
    data = BugTicketData(platform_bug_id="BUG-LK2", title="健康检查接口返回 fail",
                         description="描述", repro_steps="1. 复现", expected="ok",
                         actual="fail", env_version="v1",
                         repo_url=str(repo), affected_modules=["web"])
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        task_id = task.id

    orchestrator = make_orchestrator()
    assert orchestrator.run_preprocessing(task_id) == TaskState.SCORED
    with session_factory() as s:
        plan = s.scalar(select(VerificationPlan).where(
            VerificationPlan.task_id == task_id))
        plan.steps = [{"action": "call_api", "params": {"method": "GET"}}]  # 缺必填参数
        s.commit()

    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.FAILED
    with session_factory() as s:
        assert s.scalar(select(EnvLock)) is None
