"""API 字段缺口与感知接线测试。"""

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from autobugfixer.platform import MockBugPlatform
from autobugfixer.fixing.codex import ScriptedCodexCLI
from autobugfixer.api.app import create_app
from autobugfixer.core.models import AuditLog, Environment, VerifyRecord
from autobugfixer.core.state import TaskState
from autobugfixer.ingest.ingestion import ingest_bug


@pytest.fixture()
def api_client(settings, session_factory, platform, repo):
    with session_factory() as s:
        s.add(Environment(name="local-test", type="local",
                          deploy_script=["echo deploying"]))
        s.commit()
    return TestClient(create_app(settings, platform=platform,
                                 codex=ScriptedCodexCLI()))


def _ingest(client, repo):
    return client.post("/api/webhooks/mock", json={
        "platform_bug_id": "BUG-F01", "title": "健康检查接口返回 fail",
        "description": "d", "repro_steps": "s", "expected": "ok",
        "actual": "fail", "env_version": "v1", "repo_url": str(repo),
        "affected_modules": ["web"],
    })


# ---------- API 字段缺口 ----------

def test_task_brief_has_title_and_updated_at(api_client, repo):
    _ingest(api_client, repo)
    item = api_client.get("/api/tasks").json()["items"][0]
    assert item["title"] == "健康检查接口返回 fail"
    assert item["updated_at"]
    detail = api_client.get(f"/api/tasks/{item['id']}").json()
    assert detail["title"] == "健康检查接口返回 fail"


def test_interventions_have_deadline(api_client):
    api_client.post("/api/webhooks/mock", json={
        "platform_bug_id": "BUG-F02", "title": "信息不全", "description": "d"})
    item = api_client.get("/api/interventions?status=pending").json()["items"][0]
    assert "deadline" in item  # 字段存在（可为 None）


def test_experiences_have_extra_fields(api_client, repo):
    _ingest(api_client, repo)
    item = api_client.get("/api/experiences").json()["items"][0]
    assert "verification_points" in item
    assert "applicable_conditions" in item


def test_metrics_has_duration_and_reuse_rate(api_client, repo):
    _ingest(api_client, repo)
    metrics = api_client.get("/api/metrics/summary").json()
    assert "avg_fix_duration_minutes" in metrics
    assert metrics["avg_fix_duration_minutes"] >= 0
    assert "knowledge_reuse_rate" in metrics


# ---------- 感知接线（perception_enabled=True + 注入 stub） ----------

class _StubPerception:
    """感知服务替身：pre 有异常、post 引入新异常。"""

    def __init__(self):
        self.captured = []

    def capture(self, task, plan, phase):
        self.captured.append(phase)
        exc = SimpleNamespace(dimension="api", kind="status_error",
                              key="GET /health", detail="500")
        return SimpleNamespace(exceptions=[exc])

    def load_snapshot(self, task_id, phase):
        return object()  # 非 None 即可

    def compare(self, pre, post):
        exc = SimpleNamespace(dimension="page", kind="render_error",
                              key="/order", detail="白屏")
        return SimpleNamespace(resolved=[], persistent=[], introduced=[exc])


def test_perception_wiring(make_orchestrator, task_id, settings, session_factory,
                           environment):
    settings.perception_enabled = True
    stub = _StubPerception()
    orchestrator = make_orchestrator(perception=stub)
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED

    assert "pre_fix" in stub.captured and "post_fix" in stub.captured
    with session_factory() as s:
        verify = s.scalar(select(VerifyRecord).where(VerifyRecord.task_id == task_id))
        assert "新增异常" in verify.risk_notes  # introduced 写入风险备注
        actions = [a.action for a in s.scalars(select(AuditLog).where(
            AuditLog.task_id == task_id)).all()]
        assert "perception_capture" in actions
        assert "perception_compare" in actions


def test_perception_disabled_by_default(make_orchestrator, task_id, settings,
                                        session_factory, environment):
    """默认关闭：不注入感知也不影响现有流程。"""
    assert settings.perception_enabled is False
    stub = _StubPerception()
    orchestrator = make_orchestrator(perception=stub)  # 注入了但开关关
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED
    assert stub.captured == []
