"""FastAPI 接口测试（TestClient）：任务看板 / 详情 / webhook / 介入回写。"""

import json

import pytest
from fastapi.testclient import TestClient

from autobugfixer.features.fixing.codex import ScriptedCodexCLI
from autobugfixer.api.app import create_app
from autobugfixer.common.core.models import Environment


@pytest.fixture()
def client(settings, session_factory, platform, tmp_path):
    with session_factory() as s:
        s.add(Environment(name="local-test", type="local",
                          deploy_script=["echo deploying"]))
        s.commit()
    app = create_app(settings, platform=platform, codex=ScriptedCodexCLI())
    return TestClient(app)


def _bug_payload(repo) -> dict:
    return {
        "platform_bug_id": "BUG-API01",
        "title": "健康检查接口返回 fail",
        "description": "/health 返回 status=fail",
        "repro_steps": "1. 调用 GET /health",
        "expected": "status 为 ok",
        "actual": "status 为 fail",
        "env_version": "v1.0.0",
        "repo_url": str(repo),
        "affected_modules": ["web"],
    }


def _drive(client, task_id):
    """模拟调度器出队：webhook 安全唤醒只跑到 SCORED，修复链路由调度器推进。"""
    from autobugfixer.common.core.state import TaskState
    final = client.app.state.orchestrator.run_until_blocked(task_id)
    assert final == TaskState.CLOSED


def test_webhook_wakes_to_scored_and_scheduler_completes(client, repo):
    """P0-3：webhook 只推进预处理停在 SCORED（不插队/不双驱），调度器出队后闭环。"""
    resp = client.post("/api/webhooks/mock", json=_bug_payload(repo))
    assert resp.status_code == 200
    body = resp.json()
    assert body["created"] is True
    assert body["state"] == "SCORED"  # 安全唤醒：不越过评分闸门
    _drive(client, body["task_id"])


def test_tasks_list_and_detail(client, repo):
    task_id = client.post("/api/webhooks/mock", json=_bug_payload(repo)).json()["task_id"]
    _drive(client, task_id)
    resp = client.get("/api/tasks")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert len(items) == 1
    task_id = items[0]["id"]

    detail = client.get(f"/api/tasks/{task_id}").json()
    assert detail["state"] == "CLOSED"
    assert len(detail["timeline"]) >= 8
    assert detail["plans"][0]["steps"][0]["action"] == "input"
    assert detail["verify_records"][0]["conclusion"] == "passed"


def test_task_detail_404(client):
    assert client.get("/api/tasks/999").status_code == 404


def test_intervention_list_and_resolve(client, repo):
    # 信息不完整（仓库可用）的 Bug -> WAIT_INFO 介入
    resp = client.post("/api/webhooks/mock", json={
        "platform_bug_id": "BUG-API02", "title": "页面白屏",
        "description": "用户反馈白屏", "repo_url": str(repo),
        "affected_modules": ["web"],
    })
    assert resp.json()["state"] == "WAIT_INFO"

    pending = client.get("/api/interventions?status=pending").json()["items"]
    assert len(pending) == 1
    intervention = pending[0]
    assert intervention["type"] == "info_supplement"

    resp = client.post(f"/api/interventions/{intervention['id']}/resolve", json={
        "actor": "tester-01",
        "result": {"fields": {"repro_steps": "1. 打开首页", "expected": "正常",
                              "actual": "白屏", "env_version": "v1"}},
    })
    assert resp.status_code == 200
    assert resp.json()["task_state"] == "CLOSED"


def test_metrics_and_experiences(client, repo):
    task_id = client.post("/api/webhooks/mock", json=_bug_payload(repo)).json()["task_id"]
    _drive(client, task_id)
    metrics = client.get("/api/metrics/summary").json()
    assert metrics["auto_fix_rate"] == 1.0
    assert metrics["first_verify_pass_rate"] == 1.0
    exps = client.get("/api/experiences").json()["items"]
    assert len(exps) == 1
    assert exps[0]["category"] == "接口类"
