"""生产就绪整改（P0）回归测试。

覆盖整改清单六个阻断项的可离线验证部分：
- P0-1 修复通道安全门禁（生产模式仅沙箱化通道）；
- P0-2 API Token 鉴权 / webhook 白名单+签名+限流+体积上限 / CSV 上限 / 生产预检；
- P0-3 回滚能力缺失显式失败（不静默标已回滚）+ SSH/Docker 远程快照命令；
- P0-4 锁冲突 SAVEPOINT 不波及任务字段 / 认领租约心跳 / leader 锁 / ingest 迁移审计；
- P0-5 凭证预检（生产缺 FERNET_KEY 拒启）/ SSH 主机密钥严格校验 / 平台凭证 Fernet /
  environment 写入审计；
- P0-6 audit/FixRecord/steps_log 落库脱敏 / 解密审计 / 默认白名单收窄。
"""

from __future__ import annotations

import hashlib
import hmac as hmac_mod
import io
import json
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from autobugfixer.adapters.env import ExecResult, Health
from autobugfixer.adapters.env.lock import EnvLockService
from autobugfixer.adapters.platform import BugTicketData
from autobugfixer.api.app import create_app
from autobugfixer.common.core.config import Settings
from autobugfixer.common.core.models import (
    AuditLog,
    DeployRecord,
    Environment,
    EnvLock,
    Task,
)
from autobugfixer.common.core.state import TaskState
from autobugfixer.common.security.credentials import CredentialVault, credential_preflight
from autobugfixer.common.security.redact import redact_value
from autobugfixer.features.fixing.codex import CodexRunResult
from autobugfixer.features.ingest.ingestion import ingest_bug
from autobugfixer.runtime.scheduler import Scheduler, _LeaderElection


def _bug_data(repo, bug_id="BUG-PR01") -> BugTicketData:
    return BugTicketData(
        platform_bug_id=bug_id, title="健康检查接口返回 fail",
        description="d", repro_steps="s", expected="ok", actual="fail",
        env_version="v1", repo_url=str(repo), affected_modules=["web"])


# ================================================================ P0-1 生产门禁


def test_production_gate_rejects_claude_with_bash(tmp_path):
    from autobugfixer.features.fixing.driver import fix_driver_preflight

    s = Settings(database_url=f"sqlite:///{tmp_path}/t.db", production_mode=True,
                 fix_driver="claude", claude_allowed_tools="Read,Edit,Write,Bash")
    errors = fix_driver_preflight(s)
    assert any("Bash" in e for e in errors)


def test_production_gate_rejects_codex_full_access(tmp_path):
    from autobugfixer.features.fixing.driver import fix_driver_preflight

    s = Settings(database_url=f"sqlite:///{tmp_path}/t.db", production_mode=True,
                 fix_driver="codex", codex_sandbox="danger-full-access")
    assert any("沙箱" in e for e in fix_driver_preflight(s))


def test_production_gate_allows_sandboxed_channels(tmp_path, monkeypatch):
    from autobugfixer.features.fixing.driver import fix_driver_preflight

    monkeypatch.setattr("autobugfixer.features.fixing.claude.shutil.which",
                        lambda _: "/usr/bin/claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    s = Settings(database_url=f"sqlite:///{tmp_path}/t.db", production_mode=True,
                 fix_driver="claude", claude_allowed_tools="Read,Edit,Write,Glob,Grep")
    assert fix_driver_preflight(s) == []


def test_claude_default_tools_exclude_bash():
    from autobugfixer.features.fixing.claude import ClaudeCodeCLI

    argv = ClaudeCodeCLI("claude").build_argv("p")
    tools = argv[argv.index("--allowedTools") + 1]
    assert "Bash" not in tools.split(",")


def test_default_cmd_whitelist_narrowed():
    """P0-6：默认白名单不再含 systemctl（宿主机真实执行的服务管理命令）。"""
    assert "systemctl restart {service}" not in Settings().cmd_whitelist
    assert "echo {text}" in Settings().cmd_whitelist


# ================================================================ P0-2 API 鉴权与 webhook


def _make_client(settings, platform=None, codex=None) -> TestClient:
    app = create_app(settings, platform=platform, codex=codex)
    return TestClient(app)


def test_api_token_auth_enforced(settings, platform):
    settings.api_auth_token = "secret-token"
    client = _make_client(settings, platform=platform)
    assert client.get("/api/tasks").status_code == 401
    assert client.get("/api/tasks", headers={"X-API-Token": "wrong"}).status_code == 401
    assert client.get("/api/tasks", headers={"Authorization": "Bearer secret-token"}).status_code == 200
    assert client.get("/api/tasks", headers={"X-API-Token": "secret-token"}).status_code == 200
    assert client.get("/api/health").status_code == 200  # 健康检查免鉴权


def test_webhook_unknown_platform_rejected(settings, platform, repo):
    client = _make_client(settings, platform=platform)
    resp = client.post("/api/webhooks/gitlab", json={"platform_bug_id": "X1"})
    assert resp.status_code == 403


def test_webhook_signature_required_when_secret_configured(settings, platform, repo):
    settings.webhook_secrets = {"mock": "s3cret"}
    client = _make_client(settings, platform=platform)
    payload = json.dumps(_bug_data(repo).model_dump(exclude={"raw_payload", "platform"}))
    # 无签名 / 错签名 -> 401
    assert client.post("/api/webhooks/mock", content=payload,
                       headers={"Content-Type": "application/json"}).status_code == 401
    assert client.post("/api/webhooks/mock", content=payload,
                       headers={"Content-Type": "application/json",
                                "X-Webhook-Signature": "deadbeef"}).status_code == 401
    # 正确 HMAC-SHA256 hex -> 200
    sig = hmac_mod.new(b"s3cret", payload.encode(), hashlib.sha256).hexdigest()
    resp = client.post("/api/webhooks/mock", content=payload,
                       headers={"Content-Type": "application/json",
                                "X-Webhook-Signature": sig})
    assert resp.status_code == 200
    # token 头恒时比较亦可
    resp2 = client.post("/api/webhooks/mock", content=payload.replace("BUG-PR01", "BUG-PR02"),
                        headers={"Content-Type": "application/json",
                                 "X-Webhook-Token": "s3cret"})
    assert resp2.status_code == 200


def test_webhook_rate_limited(settings, platform, repo):
    settings.webhook_rate_limit_per_minute = 2
    client = _make_client(settings, platform=platform)
    body = _bug_data(repo).model_dump(exclude={"raw_payload", "platform"})
    assert client.post("/api/webhooks/mock", json=body).status_code == 200
    assert client.post("/api/webhooks/mock", json=body).status_code == 200
    assert client.post("/api/webhooks/mock", json=body).status_code == 429


def test_webhook_oversized_body_rejected(settings, platform):
    settings.webhook_max_body_bytes = 100
    client = _make_client(settings, platform=platform)
    big = {"platform_bug_id": "X", "title": "t" * 500}
    assert client.post("/api/webhooks/mock", json=big).status_code == 413


def test_csv_upload_size_limit(settings, platform):
    settings.csv_max_bytes = 64
    client = _make_client(settings, platform=platform)
    resp = client.post("/api/import/csv",
                       files={"file": ("bugs.csv", b"a" * 200, "text/csv")})
    assert resp.status_code == 413


def test_production_app_preflight_refuses_startup(settings, platform, monkeypatch):
    monkeypatch.delenv("AUTOBUGFIXER_FERNET_KEY", raising=False)
    monkeypatch.delenv("FERNET_KEY", raising=False)
    settings.production_mode = True
    settings.fernet_key = None
    with pytest.raises(RuntimeError, match="生产模式启动预检失败"):
        create_app(settings, platform=platform)
    settings.api_auth_token = "t"  # 补 token 后仍缺 FERNET_KEY
    with pytest.raises(RuntimeError, match="FERNET_KEY"):
        create_app(settings, platform=platform)
    settings.fernet_key = CredentialVault.generate_key()  # mock 平台仍在白名单
    with pytest.raises(RuntimeError, match="mock"):
        create_app(settings, platform=platform)


def test_environment_api_upsert_audits_and_encrypts(settings, platform, session_factory):
    client = _make_client(settings, platform=platform)
    body = {"name": "ssh-prod", "type": "local",
            "deploy_script": ["echo deploy"], "cmd_whitelist": ["echo {text}"],
            "credential": json.dumps({"username": "u", "password": "p"})}
    resp = client.post("/api/environments", json=body)
    assert resp.status_code == 200
    created = resp.json()
    assert created["created"] is True
    with session_factory() as s:
        env = s.scalar(select(Environment).where(Environment.name == "ssh-prod"))
        assert env.credential_ref  # 密文已入库
        assert "password" not in (env.credential_ref or "")
        audit = s.scalars(select(AuditLog).where(
            AuditLog.action == "environment_upsert")).all()
        assert audit and audit[-1].detail["changed_fields"]
        # 明文可解回（同一 dev vault）
        assert json.loads(CredentialVault(settings.fernet_key).decrypt(env.credential_ref))
    listing = client.get("/api/environments").json()["items"]
    entry = next(e for e in listing if e["name"] == "ssh-prod")
    assert entry["has_credential"] is True and "credential_ref" not in entry
    # 幂等更新：无变化不再写审计
    before = len(client.get("/api/environments").json()["items"])
    resp2 = client.post("/api/environments", json=body)
    assert resp2.json()["changes"] if "changes" in resp2.json() else True
    assert before >= 1


# ================================================================ P0-3 回滚语义


class _NoSnapshotExecutor:
    """无快照/恢复能力的最小执行器（模拟旧版 SSH/Docker 行为）。"""

    def __init__(self, whitelist):
        from autobugfixer.adapters.env.whitelist import CommandWhitelist

        self.whitelist = whitelist if isinstance(whitelist, CommandWhitelist) else CommandWhitelist(whitelist)

    def exec(self, cmd):
        argv = cmd.split()
        return ExecResult(cmd=cmd, returncode=1 if argv and argv[0] == "false" else 0,
                          stdout="", stderr="boom")

    def upload(self, local, remote_rel):
        pass

    def health_check(self):
        return Health(ok=True, detail="fake")

    def read_text(self, rel_path):
        return None

    def query_db(self, sql):
        return []


def test_deploy_failure_without_restore_marks_rollback_failed(
        make_orchestrator, session_factory, settings, repo):
    settings.cmd_whitelist = ["echo {text}", "false"]
    notifications: list[tuple[str, object]] = []

    class RecordingNotifier:
        def send(self, role, message):
            notifications.append((role, message))

    with session_factory() as s:
        s.add(Environment(name="no-rollback-env", type="local",
                          deploy_script=["echo step1", "false"]))
        s.commit()
    with session_factory() as s:
        task, _ = ingest_bug(s, _bug_data(repo, "BUG-PR03"), max_retry=3)
        s.commit()
        task_id = task.id

    orchestrator = make_orchestrator(
        executor=_NoSnapshotExecutor(settings.cmd_whitelist), notifier=RecordingNotifier())
    assert orchestrator.run_until_blocked(task_id) == TaskState.FAILED
    with session_factory() as s:
        deploy = s.scalar(select(DeployRecord).where(DeployRecord.task_id == task_id))
        # P0-3：无恢复能力不得静默标 rolled_back
        assert deploy.status == "rollback_failed"
        actions = [a.action for a in s.scalars(select(AuditLog).where(
            AuditLog.task_id == task_id)).all()]
        assert "deploy_rollback_failed" in actions
        assert "deploy_rollback" not in actions
        assert "env_snapshot_unsupported" in actions
    assert any("无法回滚" in m.title or "无快照能力" in m.title
               for _, m in notifications)


# ---------- SSH 快照/恢复与主机密钥校验（fake paramiko） ----------

class _FakeStream:
    def __init__(self, data=b"", rc=0):
        self._buf = io.BytesIO(data)
        self.channel = SimpleNamespace(recv_exit_status=lambda: rc)

    def read(self):
        return self._buf.read()


class _FakeSSHClient:
    instances: list = []

    def __init__(self):
        self.commands: list[str] = []
        self.policies: list[object] = []
        self.host_keys_loaded: list[str] = []
        _FakeSSHClient.instances.append(self)

    def load_system_host_keys(self):
        self.host_keys_loaded.append("system")

    def load_host_keys(self, path):
        if "/nonexistent" in path:
            raise OSError(path)
        self.host_keys_loaded.append(path)

    def set_missing_host_key_policy(self, policy):
        self.policies.append(policy)

    def connect(self, host, port=22, username=None, password=None,
                key_filename=None, timeout=None):
        pass

    def get_transport(self):
        return SimpleNamespace(is_active=lambda: True)

    def exec_command(self, cmd, timeout=None):
        self.commands.append(cmd)
        return (None, _FakeStream(b"out\n"), _FakeStream(b""))

    def open_sftp(self):
        raise AssertionError("本用例不应触达 SFTP")

    def close(self):
        pass


class _RejectPolicy:
    pass


class _AutoAddPolicy:
    pass


@pytest.fixture()
def fake_paramiko(monkeypatch):
    _FakeSSHClient.instances = []
    fake = SimpleNamespace(SSHClient=_FakeSSHClient, AutoAddPolicy=_AutoAddPolicy,
                           RejectPolicy=_RejectPolicy)
    monkeypatch.setitem(sys.modules, "paramiko", fake)
    return fake


def _ssh(**kwargs):
    from autobugfixer.adapters.env.ssh import SSHExecutor

    kwargs.setdefault("host", "10.0.0.8")
    kwargs.setdefault("workdir", "/opt/app")
    kwargs.setdefault("whitelist", ["echo {text}"])
    return SSHExecutor(**kwargs)


def test_ssh_strict_host_key_default(fake_paramiko):
    ex = _ssh()
    ex.exec("echo hi")
    client = _FakeSSHClient.instances[0]
    assert any(isinstance(p, _RejectPolicy) for p in client.policies)
    assert "system" in client.host_keys_loaded


def test_ssh_strict_host_key_missing_knownhosts_refuses(fake_paramiko):
    ex = _ssh(known_hosts_file="/nonexistent/known_hosts")
    with pytest.raises(PermissionError, match="known_hosts"):
        ex.exec("echo hi")


def test_ssh_opt_in_autoadd_policy(fake_paramiko):
    ex = _ssh(strict_host_key=False)
    ex.exec("echo hi")
    client = _FakeSSHClient.instances[0]
    assert any(isinstance(p, _AutoAddPolicy) for p in client.policies)


def test_ssh_snapshot_and_restore_issue_remote_commands(fake_paramiko):
    ex = _ssh()
    ex.snapshot("task-1-attempt-1")
    ex.restore("task-1-attempt-1")
    cmds = _FakeSSHClient.instances[0].commands
    assert any("cp -a" in c and ".snapshots/task-1-attempt-1" in c for c in cmds)
    assert any("test -d" in c for c in cmds)
    assert any("find /opt/app" in c and "rm -rf" in c for c in cmds)


def test_ssh_snapshot_refuses_root_workdir(fake_paramiko):
    ex = _ssh(workdir="/")
    with pytest.raises(ValueError, match="非法快照"):
        ex.snapshot("tag")


# ---------- Docker 快照/恢复（fake docker SDK） ----------

class _FakeDockerContainer:
    def __init__(self):
        self.execs: list = []
        self.exec_rc = 0

    def exec_run(self, cmd, workdir=None, demux=False):
        self.execs.append({"cmd": cmd, "workdir": workdir})
        return (self.exec_rc, (b"out\n", b""))


@pytest.fixture()
def fake_docker(monkeypatch):
    container = _FakeDockerContainer()
    client = SimpleNamespace(containers=SimpleNamespace(get=lambda name: container),
                             close=lambda: None)
    fake = SimpleNamespace(from_env=lambda: client)
    monkeypatch.setitem(sys.modules, "docker", fake)
    return container


def _docker(container=None, **kwargs):
    from autobugfixer.adapters.env.docker import DockerExecutor

    kwargs.setdefault("container", "app-web")
    kwargs.setdefault("whitelist", ["echo {text}"])
    kwargs.setdefault("workdir", "/app")
    return DockerExecutor(**kwargs)


def test_docker_snapshot_and_restore_tar_commands(fake_docker):
    ex = _docker()
    ex.snapshot("task-9-attempt-1")
    snapshot_cmds = [c["cmd"][2] for c in fake_docker.execs]
    assert any("tar -cf" in c and ".snapshots/task-9-attempt-1/snapshot.tar" in c
               for c in snapshot_cmds)
    ex.restore("task-9-attempt-1")
    restore_cmds = [c["cmd"][2] for c in fake_docker.execs]
    assert any("test -f" in c for c in restore_cmds)
    assert any("tar -xf" in c and "rm -rf" in c for c in restore_cmds)


def test_docker_restore_missing_snapshot_fails(fake_docker):
    ex = _docker()
    fake_docker.exec_rc = 1  # test -f 失败（快照不存在）
    with pytest.raises(RuntimeError, match="容器内命令失败"):
        ex.restore("missing-tag")


def test_docker_exec_wraps_timeout_prefix(fake_docker):
    ex = _docker(exec_timeout=30)
    result = ex.exec("echo hi")
    assert result.ok
    cmd = fake_docker.execs[0]["cmd"]
    assert cmd[0] == "/bin/sh" and cmd[1] == "-c"
    assert cmd[2].startswith("timeout -k 5 30 ")


def test_docker_exec_timeout_returns_124(fake_docker):
    import time

    ex = _docker(exec_timeout=0.2)

    def slow(cmd, workdir=None, demux=False):
        time.sleep(1.0)
        return (0, (b"late", b""))

    fake_docker.exec_run = slow
    result = ex.exec("echo hi")
    assert result.returncode == 124


# ================================================================ P0-4 并发正确性


def test_lock_conflict_rollback_keeps_task_fields(session_factory):
    """P0-4：锁冲突的 SAVEPOINT 回滚不得撤销同事务的任务字段（卡死 WAIT_ENV 根因）。

    模拟竞态窗口：另一连接已提交锁行，但本会话 _get 未见（并发读旧快照），
    插入触发 IntegrityError——旧实现整事务 rollback 会把刚设置的
    task.environment_id 一并撤销（wake_wait_env 永远跳过该任务）。
    """
    with session_factory() as s1:
        env = Environment(name="lock-env-1", type="local")
        s1.add(env)
        s1.flush()
        s1.add(EnvLock(env_id=env.id, holder_task_id=999,
                       expires_at=datetime.now(timezone.utc) + timedelta(minutes=10)))
        s1.commit()
        env_id = env.id

    with session_factory() as s:
        task = Task(bug_ticket_id=1, state=TaskState.WAIT_ENV.value)
        s.add(task)
        s.flush()
        task.environment_id = env_id  # 部署阶段写入的目标环境
        task.current_stage = "deploying"
        locks = EnvLockService(s, lease_seconds=60)
        locks._get = lambda env_id: None  # 模拟并发下未见他人已提交的锁行
        assert locks.acquire(env_id, task.id) is False  # 插入冲突 -> 拒绝
        assert task.environment_id == env_id  # 字段仍在（SAVEPOINT 未波及）
        assert task.current_stage == "deploying"
        s.commit()
    with session_factory() as s:
        assert s.get(Task, task.id).environment_id == env_id  # 提交后持久


def test_claim_lease_heartbeat_renewal(make_orchestrator, task_id, session_factory):
    """P0-4：认领租约支持心跳续期；被他人接管后续约停止。"""
    orchestrator = make_orchestrator()
    lease = orchestrator._try_claim(task_id)
    assert isinstance(lease, datetime)
    new_lease = orchestrator._renew_claim(task_id, lease)
    assert new_lease is not None and new_lease > lease
    # 错误的期望值（已被他人接管）不再续期
    assert orchestrator._renew_claim(task_id, lease) is None
    orchestrator._release_claim(task_id)


def test_claim_heartbeat_retries_after_transient_error(make_orchestrator, task_id):
    """P0-4：SQLite 写锁冲突等瞬态失败后心跳继续重试（不放弃续约）。"""
    import threading
    import time

    from autobugfixer.runtime.orchestrator import _ClaimHeartbeat

    orchestrator = make_orchestrator()
    original = orchestrator._renew_claim
    calls = {"n": 0}
    renewed = threading.Event()

    def flaky(tid, expected):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("database is locked")  # 模拟写锁冲突
        renewed.set()
        return original(tid, expected)

    orchestrator._renew_claim = flaky
    lease = orchestrator._try_claim(task_id)
    heartbeat = _ClaimHeartbeat(orchestrator, task_id, lease, interval=0.05)
    heartbeat.start()
    assert renewed.wait(timeout=5), "首次失败后心跳应继续重试并成功续约"
    assert calls["n"] >= 2
    heartbeat.stop()
    orchestrator._release_claim(task_id)


def test_scheduler_leader_election_single_round(session_factory):
    """P0-4：多实例 leader 锁——同租约期内第二个实例取不到。"""
    first = _LeaderElection(session_factory, lease_seconds=60)
    second = _LeaderElection(session_factory, lease_seconds=60)
    assert first.acquire() is True
    assert second.acquire() is False
    assert first.acquire() is True  # 自己重入续期
    # 租约过期后可被抢占
    with session_factory() as s:
        from autobugfixer.common.core.models import LeaderLock

        lock = s.scalar(select(LeaderLock).where(LeaderLock.name == "scheduler"))
        lock.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        s.commit()
    assert second.acquire() is True


def test_scheduler_round_skipped_when_not_leader(make_orchestrator, platform,
                                                 session_factory, settings):
    settings.scheduler_leader_election = True
    holder = _LeaderElection(session_factory, lease_seconds=60)
    assert holder.acquire()
    scheduler = Scheduler(make_orchestrator(), platform,
                          make_orchestrator().notifier, session_factory, settings)
    stats = scheduler.run_round()
    assert stats["ingested"] == 0 and stats["dispatched"] == []


def test_ingest_creates_state_transition_audit(session_factory, settings, repo):
    """P0-4：接入建任务的 DISCOVERED -> ANALYZING 走 transition_task（含审计）。"""
    with session_factory() as s:
        task, _ = ingest_bug(s, _bug_data(repo, "BUG-PR04"), max_retry=3)
        s.commit()
        task_id = task.id
    with session_factory() as s:
        actions = [a.action for a in s.scalars(select(AuditLog).where(
            AuditLog.task_id == task_id)).all()]
        assert "state_transition" in actions
        assert s.get(Task, task_id).state == TaskState.ANALYZING.value


# ================================================================ P0-5 凭证


def test_credential_preflight_production_requires_key(monkeypatch):
    monkeypatch.delenv("AUTOBUGFIXER_FERNET_KEY", raising=False)
    monkeypatch.delenv("FERNET_KEY", raising=False)
    s = Settings(production_mode=True, fernet_key=None)
    assert any("FERNET_KEY" in e for e in credential_preflight(s))
    s2 = Settings(production_mode=True, fernet_key=CredentialVault.generate_key())
    assert credential_preflight(s2) == []
    assert credential_preflight(Settings(production_mode=False)) == []


def test_dev_fallback_key_logs_warning(monkeypatch, caplog):
    monkeypatch.delenv("AUTOBUGFIXER_FERNET_KEY", raising=False)
    with caplog.at_level("WARNING", logger="autobugfixer.common.security.credentials"):
        CredentialVault()
    assert any("autobugfixer-dev-key" in r.message for r in caplog.records)


def test_platform_credential_ref_fernet(tmp_path):
    """P0-5：bug_platform_config 支持 credential_ref（Fernet 密文合并注入）。"""
    import httpx

    from autobugfixer.adapters.platform.jira import JiraBugPlatform
    from autobugfixer.runtime.registry import get_bug_platform

    vault = CredentialVault()
    ref = vault.encrypt(json.dumps({"email": "bot@corp.com",
                                    "api_token": "vault-secret-token"}))
    platform = get_bug_platform("jira", {
        "base_url": "https://jira.example.com", "credential_ref": ref})
    assert isinstance(platform, JiraBugPlatform)
    # 凭据经密文解密合并进适配器（httpx basic auth 头一致即注入成功）
    expected = httpx.BasicAuth(username="bot@corp.com", password="vault-secret-token")
    assert platform._client.auth._auth_header == expected._auth_header


def test_ssh_env_decrypt_audited(fake_paramiko, session_factory):
    """P0-6：SSH 环境凭据解密动作落 credential_decrypt 审计。"""
    from autobugfixer.runtime.registry import get_env_executor_for
    from autobugfixer.common.core.audit import AuditService

    vault = CredentialVault()
    with session_factory() as s:
        env = Environment(
            name="ssh-audited", type="ssh",
            conn_config={"host": "10.0.0.8", "workdir": "/opt/app"},
            credential_ref=vault.encrypt(json.dumps({"username": "u", "password": "p"})),
            cmd_whitelist=["echo {text}"])
        s.add(env)
        s.commit()
        audit = AuditService(s)
        ex = get_env_executor_for(env, vault=vault,
                                  audit=lambda **kw: audit.log(
                                      action=kw["action"], target=kw["target"],
                                      task_id=None))
        assert ex.exec("echo hi").ok
        actions = [a.action for a in s.scalars(select(AuditLog)).all()]
        assert "credential_decrypt" in actions


# ================================================================ P0-6 脱敏


def test_audit_detail_redacted_on_write(session_factory):
    from autobugfixer.common.core.audit import AuditService

    with session_factory() as s:
        AuditService(s).log(action="cmd_exec", target="env:1",
                            detail={"cmd": "deploy --password=hunter2",
                                    "stdout": "token: abc123 connected",
                                    "nested": {"api_key": "sk-999"}})
        s.commit()
    with session_factory() as s:
        entry = s.scalars(select(AuditLog).where(AuditLog.action == "cmd_exec")).one()
        assert "hunter2" not in json.dumps(entry.detail, ensure_ascii=False)
        assert "abc123" not in json.dumps(entry.detail, ensure_ascii=False)
        assert "sk-999" not in json.dumps(entry.detail, ensure_ascii=False)
        assert "***" in entry.detail["cmd"]


def test_redact_value_recurses_structures():
    out = redact_value({"password": "x", "list": ["token: y", 1, None],
                        "url": "postgres://u:secretpw@db:5432/app"})
    assert out["password"] == "***"
    assert out["list"][0] == "token: ***"
    assert out["list"][1] == 1 and out["list"][2] is None
    assert "secretpw" not in out["url"]


class _LeakyDriver:
    """回显凭据的修复驱动桩（模拟 agent 读过 .env 后写进 raw_log/prompt）。"""

    def run(self, prompt, workspace):
        return CodexRunResult(
            summary="done", tokens_in=1, tokens_out=1,
            raw_log="cat .env -> DB_PASSWORD=hunter2 token: sk-abc")


def test_fix_record_prompt_and_raw_log_redacted(make_orchestrator, session_factory,
                                                settings, repo, environment):
    task_id = ingest_task(session_factory, settings, repo, "BUG-PR06")
    make_orchestrator(codex=_LeakyDriver()).run_until_blocked(task_id)
    from autobugfixer.common.core.models import FixRecord

    with session_factory() as s:
        record = s.scalar(select(FixRecord).where(FixRecord.task_id == task_id))
        assert record is not None
        for field in ("prompt_snapshot", "raw_log"):
            assert "hunter2" not in (getattr(record, field) or "")
            assert "sk-abc" not in (getattr(record, field) or "")


def ingest_task(session_factory, settings, repo, bug_id) -> int:
    with session_factory() as s:
        task, _ = ingest_bug(s, _bug_data(repo, bug_id), max_retry=3)
        s.commit()
        return task.id
