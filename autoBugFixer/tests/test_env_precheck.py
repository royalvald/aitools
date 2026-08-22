"""环境配置预检与部署排队/回滚/锁回收测试（Spec 06 §2.1 P1 / §9 测试缺口）。"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from sqlalchemy import select

from autobugfixer.adapters.platform import BugTicketData
from autobugfixer.adapters.env import validate_environment
from autobugfixer.features.intervention.notifier import NoticeMessage
from autobugfixer.common.core.models import AuditLog, DeployRecord, Environment, EnvLock, Task
from autobugfixer.common.core.state import TaskState
from autobugfixer.adapters.env.lock import EnvLockService
from autobugfixer.features.ingest.ingestion import ingest_bug
from autobugfixer.runtime.scheduler import Scheduler


def _env(**kwargs) -> SimpleNamespace:
    defaults = dict(type="local", conn_config={}, credential_ref="",
                    cmd_whitelist=[], deploy_script=["echo deploying"])
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


# ---------- 预检规则（Spec 06 §2.1 ①-⑤） ----------

def test_validate_rejects_unknown_type():
    errors, _ = validate_environment(_env(type="ssh2"))
    assert any("type 非法" in e for e in errors)
    errors, _ = validate_environment(_env(type="k8s"))
    assert errors  # k8s 明确拒绝，不再静默降级 local


def test_validate_ssh_requires_host_and_decryptable_credential():
    errors, _ = validate_environment(_env(type="ssh", conn_config={}))
    assert any("host" in e for e in errors)
    errors, _ = validate_environment(_env(type="ssh", conn_config={"host": "h"},
                                          credential_ref="not-a-fernet"))
    assert any("解密失败" in e for e in errors)


def test_validate_docker_requires_container():
    errors, _ = validate_environment(_env(type="docker", conn_config={}))
    assert any("container" in e for e in errors)


def test_validate_requires_nonempty_whitelisted_deploy_script():
    errors, _ = validate_environment(_env(deploy_script=[]), global_whitelist=["echo {text}"])
    assert any("deploy_script 为空" in e for e in errors)
    errors, _ = validate_environment(_env(deploy_script=["rm -rf /"]),
                                     global_whitelist=["echo {text}"])
    assert any("未命中白名单" in e for e in errors)
    errors, _ = validate_environment(_env(type="ssh", conn_config={"host": "h"},
                                          cmd_whitelist=["systemctl restart {s}"],
                                          deploy_script=["systemctl restart nginx"]))
    assert errors == []


def test_validate_local_ignores_env_row_fields_with_warning():
    errors, warnings = validate_environment(
        _env(conn_config={"host": "x"}, cmd_whitelist=["false"]),
        global_whitelist=["echo {text}"])
    assert errors == []
    assert len(warnings) == 2  # conn_config 与 cmd_whitelist 均提示不生效


# ---------- 部署阶段接线：预检失败未取锁即 FAILED ----------

def test_deploy_prefailure_rejects_before_lock(make_orchestrator, session_factory,
                                               settings, repo):
    with session_factory() as s:
        env = Environment(name="bad-type", type="ssh2", deploy_script=["echo x"])
        s.add(env)
        s.commit()
    data = BugTicketData(platform_bug_id="BUG-EV1", title="健康检查接口返回 fail",
                         description="d", repro_steps="s", expected="ok", actual="fail",
                         env_version="v1", repo_url=str(repo), affected_modules=["web"])
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        task_id = task.id

    final = make_orchestrator().run_until_blocked(task_id)
    assert final == TaskState.FAILED
    with session_factory() as s:
        assert s.scalar(select(EnvLock)) is None  # 未取锁
        actions = {a.action for a in s.scalars(select(AuditLog).where(
            AuditLog.task_id == task_id)).all()}
        assert "env_config_rejected" in actions


# ---------- WAIT_ENV 排队 + env_lock_wait 审计（Spec 06 §9 缺口） ----------

def test_deploy_waits_when_env_locked(make_orchestrator, session_factory, settings,
                                      repo, environment):
    data = BugTicketData(platform_bug_id="BUG-EV2", title="健康检查接口返回 fail",
                         description="d", repro_steps="s", expected="ok", actual="fail",
                         env_version="v1", repo_url=str(repo), affected_modules=["web"])
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        task_id = task.id

    orchestrator = make_orchestrator()
    assert orchestrator.run_preprocessing(task_id) == TaskState.SCORED

    # 他人在临界区内持有锁 -> 本任务评分/修复/部署排队，停在 WAIT_ENV
    with session_factory() as s:
        assert EnvLockService(s, lease_seconds=300).acquire(environment.id, task_id=999)
        s.commit()
    assert orchestrator.run_until_blocked(task_id) == TaskState.WAIT_ENV
    with session_factory() as s:
        actions = [a.action for a in s.scalars(select(AuditLog).where(
            AuditLog.task_id == task_id)).all()]
        assert "env_lock_wait" in actions
        assert "env_lock_acquire" not in actions

    # 锁释放 + 人工唤醒（等价 POST /tasks/{id}/retry 的 WAIT_ENV 分支）-> 重入直至闭环
    with session_factory() as s:
        EnvLockService(s).release(environment.id, 999)
        task = s.get(Task, task_id)
        task.state = TaskState.DEPLOYING.value
        s.commit()
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED


# ---------- 回滚留痕 + ops 告警（Spec 06 §9 缺口） ----------

def test_deploy_failure_rolled_back_and_ops_notified(
        make_orchestrator, session_factory, settings, repo):
    settings.cmd_whitelist = ["echo {text}", "false"]  # "false" 命中白名单但必失败
    notifications: list[tuple[str, NoticeMessage]] = []

    class RecordingNotifier:
        def send(self, role, message):
            notifications.append((role, message))

    with session_factory() as s:
        env = Environment(name="failing-env", type="local",
                          deploy_script=["echo step1", "false"])
        s.add(env)
        s.commit()
    data = BugTicketData(platform_bug_id="BUG-EV3", title="健康检查接口返回 fail",
                         description="d", repro_steps="s", expected="ok", actual="fail",
                         env_version="v1", repo_url=str(repo), affected_modules=["web"])
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        task_id = task.id

    final = make_orchestrator(notifier=RecordingNotifier()).run_until_blocked(task_id)
    assert final == TaskState.FAILED
    with session_factory() as s:
        deploy = s.scalar(select(DeployRecord).where(DeployRecord.task_id == task_id))
        assert deploy.status == "rolled_back"
        cmds = [entry.get("cmd") for entry in deploy.steps_log]
        assert any("rollback to" in str(c) for c in cmds)
        actions = [a.action for a in s.scalars(select(AuditLog).where(
            AuditLog.task_id == task_id)).all()]
        assert "deploy_rollback" in actions
        assert "env_lock_release" in actions
    assert any(role == "ops" for role, _ in notifications)


# ---------- 调度器回收过期锁（Spec 06 §9 缺口） ----------

def test_scheduler_reclaims_expired_lock(make_orchestrator, session_factory,
                                         platform, settings, environment):
    notifier = make_orchestrator().notifier
    scheduler = Scheduler(make_orchestrator(), platform, notifier,
                          session_factory, settings)
    with session_factory() as s:
        s.add(EnvLock(env_id=environment.id, holder_task_id=999,
                      expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
        s.commit()
    stats = scheduler.run_round()
    assert stats["locks_reclaimed"] == 1
    with session_factory() as s:
        assert s.scalar(select(EnvLock)) is None
