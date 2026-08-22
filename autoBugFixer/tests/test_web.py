"""Web 控制台挂载测试：静态页面可访问且不影响 /api/** 路由。"""

import pytest
from fastapi.testclient import TestClient

from autobugfixer.api.app import create_app
from autobugfixer.common.core.models import Environment
from autobugfixer.api.web import STATIC_DIR, mount_web


@pytest.fixture()
def client(settings, session_factory, platform):
    with session_factory() as s:
        s.add(Environment(name="local-test", type="local",
                          deploy_script=["echo deploying"]))
        s.commit()
    app = create_app(settings, platform=platform)
    mount_web(app)
    return TestClient(app)


def test_index_returns_html(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert "AutoBugFixer" in resp.text


def test_static_assets_accessible(client):
    for name in ("app.js", "style.css"):
        resp = client.get(f"/static/{name}")
        assert resp.status_code == 200
        assert len(resp.content) > 0


def test_static_dir_layout():
    """静态目录结构完整（index/app/style 三件套）。"""
    for name in ("index.html", "app.js", "style.css"):
        assert (STATIC_DIR / name).is_file(), name


def test_api_routes_unaffected_by_mount(client, repo):
    # /api/** 不受 / 与 /static 挂载影响
    assert client.get("/api/tasks").status_code == 200
    assert client.get("/api/metrics/summary").status_code == 200
    assert client.get("/api/tasks/999").status_code == 404

    payload = {
        "platform_bug_id": "BUG-WEB01",
        "title": "健康检查接口返回 fail",
        "description": "/health 返回 status=fail",
        "repro_steps": "1. 调用 GET /health",
        "expected": "status 为 ok",
        "actual": "status 为 fail",
        "env_version": "v1.0.0",
        "repo_url": str(repo),
        "affected_modules": ["web"],
    }
    resp = client.post("/api/webhooks/mock", json=payload)
    assert resp.status_code == 200
    assert resp.json()["created"] is True

    items = client.get("/api/tasks").json()["items"]
    assert len(items) == 1
    assert client.get(f"/api/tasks/{items[0]['id']}").status_code == 200


def test_openapi_still_available(client):
    # 挂载后文档路由仍正常
    assert client.get("/openapi.json").status_code == 200
