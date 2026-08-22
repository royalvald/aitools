"""真实外部系统适配器的离线测试（设计文档 6.2）。

- Jira / 禅道：httpx MockTransport 构造典型响应；
- SSH / Docker：monkeypatch sys.modules 注入 fake paramiko / docker 模块。

全部离线可跑，不触网、不依赖 paramiko/docker 真实安装。
（Claude Code CLI 通道已随 Spec 05 codex 化移除，其测试见 test_codex_cli.py。）
"""

from __future__ import annotations

import io
import json
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from autobugfixer.platform import BugPatch, BugTicketData, MockBugPlatform
from autobugfixer.platform.jira import JiraBugPlatform
from autobugfixer.platform.zentao import ZentaoBugPlatform
from autobugfixer.env.docker import DockerExecutor
from autobugfixer.env.ssh import SSHExecutor
from autobugfixer.runtime.registry import (
    get_bug_platform,
    get_env_executor,
    get_env_executor_for,
    register_builtin_adapters,
    registered_adapters,
)
from autobugfixer.env.whitelist import CommandRejectedError

# ---------------------------------------------------------------- Jira

JIRA_SEARCH = {
    "issues": [
        {
            "key": "PROJ-101",
            "fields": {
                "summary": "健康检查接口返回 fail",
                "description": {
                    "type": "doc",
                    "version": 1,
                    "content": [
                        {"type": "paragraph", "content": [
                            {"type": "text", "text": "测试环境 /health 返回 status=fail。"}]},
                    ],
                },
                "customfield_10010": {"type": "doc", "version": 1, "content": [
                    {"type": "paragraph", "content": [
                        {"type": "text", "text": "1. 部署\n2. 调 /health"}]}]},
                "customfield_10011": "status 为 ok",
                "customfield_10012": "status 为 fail",
                "customfield_10013": "v1.2.0",
                "attachment": [{"filename": "log.txt", "content": "https://x/log.txt"}],
                "labels": [],
                "components": [{"name": "web"}],
            },
        },
        {
            "key": "PROJ-102",
            "fields": {"summary": "页面白屏", "description": None,
                       "attachment": [], "labels": ["web"], "components": []},
        },
    ]
}


def _jira_client(calls: list) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        path = request.url.path
        if path == "/rest/api/3/search":
            return httpx.Response(200, json=JIRA_SEARCH)
        if path == "/rest/api/3/issue/PROJ-101":
            return httpx.Response(200, json=JIRA_SEARCH["issues"][0])
        if path == "/rest/api/3/issue/PROJ-101/comment":
            return httpx.Response(201, json={"id": "10001"})
        if path == "/rest/api/3/issue/PROJ-101/transitions":
            if request.method == "GET":
                return httpx.Response(200, json={"transitions": [
                    {"id": "31", "name": "Done", "to": {"name": "Done"}}]})
            return httpx.Response(204)
        return httpx.Response(404, json={"errorMessages": ["not found"]})

    return httpx.Client(
        base_url="https://jira.example.com",
        transport=httpx.MockTransport(handler),
        auth=("bot@corp.com", "token"),
    )


def _jira(calls: list) -> JiraBugPlatform:
    return JiraBugPlatform(
        "https://jira.example.com", "bot@corp.com", "token",
        field_map={
            "repro_steps": "customfield_10010",
            "expected": "customfield_10011",
            "actual": "customfield_10012",
            "env_version": "customfield_10013",
        },
        client=_jira_client(calls),
    )


def test_jira_list_bugs_maps_fields():
    calls: list = []
    bugs = _jira(calls).list_bugs()
    assert len(bugs) == 2
    full = bugs[0]
    assert full.platform == "jira"
    assert full.platform_bug_id == "PROJ-101"
    assert full.title == "健康检查接口返回 fail"
    assert "status=fail" in full.description
    assert "部署" in full.repro_steps
    assert full.expected == "status 为 ok"
    assert full.actual == "status 为 fail"
    assert full.env_version == "v1.2.0"
    assert full.attachments == ["https://x/log.txt"]
    assert full.affected_modules == ["web"]
    assert full.missing_fields == []
    # 信息不完整的 issue：missing_fields 按 ingestion 约定标记
    assert set(bugs[1].missing_fields) >= {"description", "repro_steps", "expected"}
    assert calls[0][0] == "GET" and calls[0][1] == "/rest/api/3/search"


def test_jira_list_bugs_since_appends_jql():
    calls: list = []
    client = _jira_client(calls)
    captured: dict = {}

    orig_get = client.get

    def spy_get(url, **kwargs):
        captured.update(kwargs.get("params", {}))
        return orig_get(url, **kwargs)

    client.get = spy_get
    platform = JiraBugPlatform("https://jira.example.com", "e", "t", client=client)
    platform.list_bugs(since=datetime(2026, 7, 1, tzinfo=timezone.utc))
    assert 'updated >= "2026/07/01 00:00"' in captured["jql"]


def test_jira_get_bug_404_raises():
    calls: list = []
    with pytest.raises(RuntimeError, match="Jira API 错误 404"):
        _jira(calls).get_bug("NOPE-1")


def test_jira_update_bug_comment_and_transition():
    calls: list = []
    _jira(calls).update_bug("PROJ-101", BugPatch(status="Done", comment="已自动修复"))
    paths = [(m, p) for m, p in calls]
    assert ("POST", "/rest/api/3/issue/PROJ-101/comment") in paths
    assert ("GET", "/rest/api/3/issue/PROJ-101/transitions") in paths
    assert ("POST", "/rest/api/3/issue/PROJ-101/transitions") in paths


def test_jira_update_bug_unknown_transition():
    calls: list = []
    with pytest.raises(ValueError, match="无可用状态流转"):
        _jira(calls).update_bug("PROJ-101", BugPatch(status="Nonexistent"))


# ---------------------------------------------------------------- 禅道

ZENTAO_BUG = {
    "id": 7,
    "title": "健康检查接口返回 fail",
    "steps": "<p>[步骤] 1. 部署<br />2. 调 /health</p><p>[结果] status 为 fail</p>"
             "<p>[期望] status 为 ok</p>",
    "openedBuild": {"1": "v1.2.0"},
    "module": "web",
    "status": "active",
    "openedDate": "2026-07-20 10:00:00",
    "editedDate": "2026-07-21 09:00:00",
}


def _zentao_client(calls: list) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path,
                      request.headers.get("token", "")))
        path = request.url.path
        if path == "/api.php/v1/tokens":
            return httpx.Response(200, json={"token": "t-123"})
        if path == "/api.php/v1/bugs":
            return httpx.Response(200, json={"page": 1, "total": 1, "bugs": [ZENTAO_BUG]})
        if path == "/api.php/v1/bugs/7":
            if request.method == "PUT":
                return httpx.Response(200, json={})
            return httpx.Response(200, json=ZENTAO_BUG)
        if path == "/api.php/v1/bugs/7/resolve":
            return httpx.Response(200, json={})
        return httpx.Response(404, json={"error": "not found"})

    return httpx.Client(
        base_url="https://zentao.example.com", transport=httpx.MockTransport(handler)
    )


def test_zentao_login_list_and_detail_mapping():
    calls: list = []
    platform = ZentaoBugPlatform(
        "https://zentao.example.com", "admin", "secret", client=_zentao_client(calls)
    )
    bugs = platform.list_bugs()
    assert len(bugs) == 1
    # tokens 登录取 token，后续请求带 Token 头
    assert calls[0][:2] == ("POST", "/api.php/v1/tokens")
    assert all(c[2] == "t-123" for c in calls[1:])

    bug = platform.get_bug("7")
    assert bug.platform == "zentao"
    assert bug.platform_bug_id == "7"
    assert bug.title == "健康检查接口返回 fail"
    assert "部署" in bug.repro_steps
    assert bug.actual == "status 为 fail"
    assert bug.expected == "status 为 ok"
    assert bug.env_version == "v1.2.0"
    assert bug.affected_modules == ["web"]
    # 禅道无独立描述字段：保留空值 + missing_fields 标记
    assert "description" in bug.missing_fields
    assert bug.raw_payload["id"] == 7


def test_zentao_list_bugs_since_filters():
    calls: list = []
    platform = ZentaoBugPlatform(
        "https://zentao.example.com", "admin", "secret", client=_zentao_client(calls)
    )
    assert platform.list_bugs(since=datetime(2026, 7, 22)) == []
    assert len(platform.list_bugs(since=datetime(2026, 7, 20))) == 1


def test_zentao_update_bug_resolve_with_comment():
    calls: list = []
    platform = ZentaoBugPlatform(
        "https://zentao.example.com", "admin", "secret", client=_zentao_client(calls)
    )
    platform.update_bug("7", BugPatch(status="resolved", comment="已修复"))
    assert ("POST", "/api.php/v1/bugs/7/resolve", "t-123") in calls


def test_zentao_update_bug_comment_only_uses_put():
    calls: list = []
    platform = ZentaoBugPlatform(
        "https://zentao.example.com", "admin", "secret", client=_zentao_client(calls)
    )
    platform.update_bug("7", BugPatch(comment="补充说明"))
    assert ("PUT", "/api.php/v1/bugs/7", "t-123") in calls


def test_zentao_update_bug_unmapped_status():
    calls: list = []
    platform = ZentaoBugPlatform(
        "https://zentao.example.com", "admin", "secret", client=_zentao_client(calls)
    )
    with pytest.raises(ValueError, match="status_actions"):
        platform.update_bug("7", BugPatch(status="weird-status"))


# ---------------------------------------------------------------- SSH（fake paramiko）


class _FakeStream:
    def __init__(self, data: bytes, rc: int = 0):
        self._buf = io.BytesIO(data)
        self.channel = SimpleNamespace(recv_exit_status=lambda: rc)

    def read(self) -> bytes:
        return self._buf.read()


class _FakeSFTP:
    def __init__(self):
        self.puts: list[tuple[str, str]] = []
        self.gets: list[tuple[str, str]] = []
        self.mkdirs: list[str] = []

    def put(self, local, remote):
        self.puts.append((local, remote))

    def get(self, remote, local):
        self.gets.append((remote, local))
        Path(local).write_text("remote-content", encoding="utf-8")

    def mkdir(self, path):
        self.mkdirs.append(path)

    def open(self, path, mode="r"):
        return io.BytesIO(b"remote file text")

    def stat(self, path):
        raise IOError("not a dir")

    def listdir_attr(self, path):
        return []


class _FakeSSHClient:
    instances: list = []

    def __init__(self):
        self.commands: list[str] = []
        self.connect_args: dict = {}
        self.sftp = _FakeSFTP()
        _FakeSSHClient.instances.append(self)

    def set_missing_host_key_policy(self, policy):
        pass

    def connect(self, host, port=22, username=None, password=None,
                key_filename=None, timeout=None):
        self.connect_args = {"host": host, "port": port, "username": username,
                             "password": password, "key_filename": key_filename}

    def exec_command(self, cmd, timeout=None):
        self.commands.append(cmd)
        return (None, _FakeStream(b"ok-output\n"), _FakeStream(b""))

    def open_sftp(self):
        return self.sftp

    def close(self):
        pass


@pytest.fixture()
def fake_paramiko(monkeypatch):
    _FakeSSHClient.instances = []
    fake = SimpleNamespace(SSHClient=_FakeSSHClient, AutoAddPolicy=object)
    monkeypatch.setitem(sys.modules, "paramiko", fake)
    return fake


def _ssh(**kwargs) -> SSHExecutor:
    kwargs.setdefault("host", "10.0.0.8")
    kwargs.setdefault("username", "deploy")
    kwargs.setdefault("whitelist", ["echo {text}", "curl -fsS {url}"])
    return SSHExecutor(**kwargs)


def test_ssh_exec_passes_whitelist_and_wraps_workdir(fake_paramiko):
    ex = _ssh(workdir="/opt/app")
    result = ex.exec("echo hello")
    assert result.ok and result.stdout == "ok-output"
    client = _FakeSSHClient.instances[0]
    assert client.commands == ["cd /opt/app && echo hello"]
    assert client.connect_args["username"] == "deploy"


def test_ssh_exec_rejects_command_outside_whitelist(fake_paramiko):
    ex = _ssh()
    with pytest.raises(CommandRejectedError):
        ex.exec("rm -rf /")
    assert _FakeSSHClient.instances == []  # 拒绝发生在连接前


def test_ssh_upload_download_and_read_text(fake_paramiko, tmp_path):
    ex = _ssh(workdir="/opt/app")
    local = tmp_path / "build.tar.gz"
    local.write_text("pkg", encoding="utf-8")
    ex.upload(local, "dist/build.tar.gz")
    sftp = _FakeSSHClient.instances[0].sftp
    assert sftp.puts == [(str(local), "/opt/app/dist/build.tar.gz")]

    ex.download("logs/app.log", tmp_path / "out" / "app.log")
    assert (tmp_path / "out" / "app.log").read_text(encoding="utf-8") == "remote-content"

    assert ex.read_text("conf/app.yaml") == "remote file text"


def test_ssh_health_check_cmd_and_connectivity(fake_paramiko):
    ex = _ssh(health_cmd="curl -fsS http://localhost/health")
    health = ex.health_check()
    assert health.ok and health.detail == "ok-output"

    ex2 = _ssh()  # 无 health_cmd：仅检查连通性
    assert ex2.health_check().ok


def test_ssh_missing_paramiko_hint(monkeypatch):
    monkeypatch.setitem(sys.modules, "paramiko", None)  # import 时触发 ImportError
    ex = _ssh()
    with pytest.raises(RuntimeError, match="pip install paramiko"):
        ex.health_check()


def test_ssh_from_env_model_decrypts_credentials(fake_paramiko):
    from autobugfixer.security.credentials import CredentialVault

    vault = CredentialVault()
    secret = vault.encrypt(json.dumps({"username": "deploy", "password": "s3cret"}))
    env = SimpleNamespace(
        conn_config={"host": "10.0.0.9", "workdir": "/srv/app"},
        credential_ref=secret,
        cmd_whitelist=["echo {text}"],
    )
    ex = SSHExecutor.from_env_model(env, vault=vault)
    result = ex.exec("echo hi")
    assert result.ok
    client = _FakeSSHClient.instances[0]
    assert client.connect_args["host"] == "10.0.0.9"
    assert client.connect_args["password"] == "s3cret"  # 解密注入成功


# ---------------------------------------------------------------- Docker（fake docker SDK）


class _FakeContainer:
    def __init__(self):
        self.status = "running"
        self.execs: list[dict] = []
        self.archives: list[tuple[str, bytes]] = []
        self.files: dict[str, bytes] = {}

    def reload(self):
        pass

    def exec_run(self, cmd, workdir=None, demux=False):
        self.execs.append({"cmd": cmd, "workdir": workdir, "demux": demux})
        return (0, (b"docker-out\n", b""))

    def put_archive(self, path, data):
        self.archives.append((path, bytes(data)))

    def get_archive(self, path):
        if path not in self.files:
            raise FileNotFoundError(path)
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            info = tarfile.TarInfo(name=PurePosixName(path))
            payload = self.files[path]
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
        return (iter([buf.getvalue()]), {"name": PurePosixName(path)})


def PurePosixName(path: str) -> str:
    return str(path).lstrip("/").replace("/", "_")


class _FakeDockerClient:
    def __init__(self, container):
        self.containers = SimpleNamespace(get=lambda name: container)

    def close(self):
        pass


@pytest.fixture()
def fake_docker(monkeypatch):
    container = _FakeContainer()
    client = _FakeDockerClient(container)
    fake = SimpleNamespace(from_env=lambda: client,
                           DockerClient=lambda base_url=None: client)
    monkeypatch.setitem(sys.modules, "docker", fake)
    return container


def _docker(**kwargs) -> DockerExecutor:
    kwargs.setdefault("container", "app-web")
    kwargs.setdefault("whitelist", ["echo {text}", "curl -fsS {url}"])
    kwargs.setdefault("workdir", "/app")
    return DockerExecutor(**kwargs)


def test_docker_exec_whitelist_and_output(fake_docker):
    ex = _docker()
    result = ex.exec("echo hi")
    assert result.ok and result.stdout == "docker-out"
    call = fake_docker.execs[0]
    assert call["cmd"] == ["/bin/sh", "-c", "echo hi"]
    assert call["workdir"] == "/app"

    with pytest.raises(CommandRejectedError):
        ex.exec("rm -rf /")
    assert len(fake_docker.execs) == 1  # 被拒命令未执行


def test_docker_upload_tar_and_read_text(fake_docker, tmp_path):
    ex = _docker()
    local = tmp_path / "app.bin"
    local.write_bytes(b"bin-data")
    ex.upload(local, "dist/app.bin")
    path, tar_bytes = fake_docker.archives[0]
    assert path == "/app/dist"
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tar:
        assert tar.extractfile("app.bin").read() == b"bin-data"

    fake_docker.files["/app/conf/app.yaml"] = b"yaml-content"
    assert ex.read_text("conf/app.yaml") == "yaml-content"
    assert ex.read_text("conf/missing.yaml") is None


def test_docker_health_check(fake_docker):
    ex = _docker(health_cmd="curl -fsS http://localhost/health")
    assert ex.health_check().ok
    fake_docker.status = "exited"
    assert not ex.health_check().ok


def test_docker_missing_sdk_hint(monkeypatch):
    monkeypatch.setitem(sys.modules, "docker", None)
    ex = _docker()
    with pytest.raises(RuntimeError, match="pip install docker"):
        ex.health_check()


# ---------------------------------------------------------------- 注册表


def test_registry_builtin_names():
    register_builtin_adapters()
    names = registered_adapters()
    assert names["bug_platforms"] == ["jira", "mock", "zentao"]
    assert names["env_executors"] == ["docker", "local", "ssh"]


def test_registry_get_bug_platform():
    assert isinstance(get_bug_platform("mock"), MockBugPlatform)
    jira = get_bug_platform("jira", {
        "base_url": "https://jira.example.com", "email": "e", "api_token": "t",
        "client": _jira_client([]),
    })
    assert isinstance(jira, JiraBugPlatform)
    with pytest.raises(KeyError, match="未知缺陷平台适配器"):
        get_bug_platform("gitlab")


def test_registry_get_env_executor_local(tmp_path):
    ex = get_env_executor("local", {"env_root": str(tmp_path), "whitelist": ["echo {text}"]})
    result = ex.exec("echo hello")
    assert result.ok and result.stdout == "hello"


def test_registry_get_env_executor_for_model(tmp_path):
    env = SimpleNamespace(type="local", conn_config={"env_root": str(tmp_path)},
                          cmd_whitelist=["echo {text}"], credential_ref="")
    assert get_env_executor_for(env).exec("echo hi").ok
    env_ssh = SimpleNamespace(type="ssh", conn_config={"host": "h"},
                              cmd_whitelist=[], credential_ref="")
    assert isinstance(get_env_executor_for(env_ssh), SSHExecutor)


# ---------------------------------------------------------------- 包契约


def test_stage_package_contracts_importable():
    """按阶段分包后（refactor/stage-packages），platform/env 包公共契约可从包根导入。"""
    from autobugfixer.platform import (
        BugPlatformAdapter, BugTicketData, MockBugPlatform, sample_bugs,
    )
    from autobugfixer.env import (
        EnvExecutor, ExecResult, Health, LocalExecutor,
    )

    bug = MockBugPlatform().get_bug("BUG-1001")
    assert isinstance(bug, BugTicketData)
    assert sample_bugs()
