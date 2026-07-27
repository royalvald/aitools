"""三维 Bug 表现感知测试（FR-FIX-02）：全离线。

- 页面层：httpx MockTransport + 本地 HTML 夹具（Playwright 缺包走降级路径）
- 数据库层：仿真环境内 SQLite（LocalExecutor）
- 接口层：httpx MockTransport（含超时重试）
- 服务层：三维采集、只读 SQL 强校验、pre/post 对比差异摘要、快照落库
"""

from __future__ import annotations

import sqlite3

import httpx
import pytest

from autobugfixer.adapters.env_executor import LocalExecutor
from autobugfixer.db import init_db, make_engine, make_session_factory
from autobugfixer.models import BugTicket, Task, VerificationPlan
from autobugfixer.perception import (
    DBPerception,
    PagePerception,
    APIPerception,
    PerceptionService,
)
from autobugfixer.perception.service import (
    PerceptionSnapshotRecord,
    init_perception_db,
)

HTML_BROKEN = "<html><body><h1>订单页</h1></body></html>"  # 缺 #submit-btn
HTML_FIXED = ('<html><body><h1>订单页</h1>'
              '<button id="submit-btn">提交</button></body></html>')

# 覆盖三维的方案步骤
PLAN_STEPS = [
    {"action": "open_page", "params": {"url": "/order"}},
    {"action": "assert_element", "params": {"selector": "#submit-btn", "state": "present"}},
    {"action": "assert_element", "params": {"selector": "#error-banner", "state": "present"}},
    {"action": "click", "params": {"selector": "#submit-btn"}},
    {"action": "query_db", "params": {"sql": "SELECT * FROM orders"}},
    {"action": "assert_db", "params": {"sql": "SELECT * FROM orders", "expect": "row_count>=1"}},
    {"action": "call_api", "params": {"method": "GET", "path": "/api/health"}},
    {"action": "call_api", "params": {"method": "GET", "path": "/api/other"}},
]


@pytest.fixture()
def state() -> dict:
    """仿真环境可变状态：切换 pre/post 环境表现。"""
    return {"html": HTML_BROKEN, "health": 500, "other": 200}


@pytest.fixture()
def http_client(state) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/order":
            return httpx.Response(200, text=state["html"])
        if path == "/api/health":
            code = state["health"]
            return httpx.Response(code, json={"status": "ok"} if code == 200 else {"error": "boom"})
        if path == "/api/other":
            code = state["other"]
            return httpx.Response(code, json={"ok": True} if code == 200 else {"error": "bad"})
        if path == "/api/slow":
            raise httpx.ReadTimeout("read timeout", request=request)
        return httpx.Response(404, text="not found")

    return httpx.Client(transport=httpx.MockTransport(handler),
                        base_url="http://testserver", timeout=1.0)


@pytest.fixture()
def executor(tmp_path) -> LocalExecutor:
    """仿真环境：app.db 内置 orders 表一行。"""
    env_root = tmp_path / "testenv"
    env_root.mkdir()
    conn = sqlite3.connect(env_root / "app.db")
    conn.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT)")
    conn.execute("INSERT INTO orders VALUES (1, 'paid')")
    conn.commit()
    conn.close()
    return LocalExecutor(env_root)


@pytest.fixture()
def session_factory(tmp_path):
    engine = make_engine(f"sqlite:///{tmp_path}/perception.db")
    init_db(engine)
    init_perception_db(engine)  # 注册本模块自有表
    return make_session_factory(engine)


@pytest.fixture()
def task_and_plan(session_factory):
    with session_factory() as s:
        bug = BugTicket(platform="mock", platform_bug_id="BUG-P001", title="下单按钮缺失")
        s.add(bug)
        s.flush()
        task = Task(bug_ticket_id=bug.id, state="FIXING")
        s.add(task)
        s.flush()
        plan = VerificationPlan(task_id=task.id, version=1, steps=PLAN_STEPS)
        s.add(plan)
        s.commit()
        return task, plan


@pytest.fixture()
def service(session_factory, executor, http_client, tmp_path) -> PerceptionService:
    return PerceptionService(
        session_factory=session_factory,
        evidence_root=tmp_path / "evidence",
        page=PagePerception(client=http_client, force_fallback=True),  # 强制降级路径
        db=DBPerception(executor),
        api=APIPerception(client=http_client),
    )


def _exc_kinds(snapshot):
    return {(e.dimension, e.kind, e.key) for e in snapshot.exceptions}


# ---- 三维采集 ----

def test_capture_three_dimensions(service, task_and_plan, session_factory):
    task, plan = task_and_plan
    snap = service.capture(task, plan, "pre_fix")

    assert snap.phase == "pre_fix"
    # 页面：元素缺失 + 交互失效（降级模式），HTML 留档
    assert snap.page_result is not None and snap.page_result.mode == "httpx"
    assert snap.page_result.html_uri and (service.evidence_root / f"task_{task.id}/pre_fix/page.html").exists()
    # 数据库：查询与断言均通过
    assert snap.db_result is not None
    assert all(c.passed for c in snap.db_result.checkpoints)
    assert snap.db_result.checkpoints[0].row_count == 1
    # 接口：/api/health 500 被抓到，/api/other 正常
    assert snap.api_result is not None
    status_by_path = {c.path: c.status_code for c in snap.api_result.calls}
    assert status_by_path == {"/api/health": 500, "/api/other": 200}

    kinds = _exc_kinds(snap)
    assert ("page", "element_missing", "#submit-btn") in kinds
    assert ("page", "element_missing", "#error-banner") in kinds
    assert ("page", "interaction_failed", "#submit-btn") in kinds
    assert ("api", "status_error", "GET /api/health") in kinds
    assert "boom" in next(e for e in snap.exceptions if e.kind == "status_error").detail
    assert not any(e.dimension == "db" for e in snap.exceptions)

    # 落库 + 快照文件
    with session_factory() as s:
        rec = s.query(PerceptionSnapshotRecord).filter_by(task_id=task.id, phase="pre_fix").one()
        assert rec.exception_count == len(snap.exceptions)
        assert rec.snapshot["task_id"] == task.id
    assert (service.evidence_root / f"task_{task.id}/pre_fix/snapshot.json").exists()


def test_dimension_toggle(service, task_and_plan):
    task, plan = task_and_plan
    snap = service.capture(task, plan, "pre_fix", enable_api=False, enable_db=False)
    assert snap.page_result is not None
    assert snap.api_result is None and snap.db_result is None
    assert all(e.dimension == "page" for e in snap.exceptions)


# ---- 只读 SQL 强校验 ----

def test_readonly_sql_enforced(service, task_and_plan, executor, session_factory):
    task, _ = task_and_plan
    with session_factory() as s:
        plan = VerificationPlan(task_id=task.id, version=2, steps=[
            {"action": "query_db", "params": {"sql": "DELETE FROM orders"}},
            {"action": "query_db", "params": {"sql": "UPDATE orders SET status='x'"}},
            {"action": "assert_db", "params": {"sql": " DROP TABLE orders", "expect": "row_count>=0"}},
            {"action": "query_db", "params": {"sql": "SELECT * FROM orders"}},
        ])
        s.add(plan)
        s.commit()
        snap = service.capture(task, plan, "pre_fix")

    rejected = [e for e in snap.exceptions if e.kind == "readonly_rejected"]
    assert len(rejected) == 3  # DELETE/UPDATE/DROP 全部拒绝
    # 被拒 SQL 未执行：数据仍在
    assert executor.query_db("SELECT * FROM orders") == [{"id": 1, "status": "paid"}]
    # 合法 SELECT 正常执行
    assert snap.db_result.checkpoints[-1].passed
    assert snap.db_result.checkpoints[-1].row_count == 1


def test_assert_db_failed(service, task_and_plan, session_factory):
    task, _ = task_and_plan
    with session_factory() as s:
        plan = VerificationPlan(task_id=task.id, version=3, steps=[
            {"action": "assert_db", "params": {"sql": "SELECT * FROM orders", "expect": "row_count>=5"}},
        ])
        s.add(plan)
        s.commit()
        snap = service.capture(task, plan, "pre_fix")
    assert ("db", "assert_failed", "SELECT * FROM orders") in _exc_kinds(snap)


# ---- 接口超时重试 ----

def test_api_timeout_with_one_retry(service, task_and_plan, session_factory):
    task, _ = task_and_plan
    with session_factory() as s:
        plan = VerificationPlan(task_id=task.id, version=4, steps=[
            {"action": "call_api", "params": {"method": "GET", "path": "/api/slow"}},
        ])
        s.add(plan)
        s.commit()
        snap = service.capture(task, plan, "pre_fix")
    assert ("api", "timeout", "GET /api/slow") in _exc_kinds(snap)
    assert snap.api_result.calls[0].attempts == 2  # 重试一次后放弃


# ---- pre/post 对比 ----

def test_compare_pre_post(service, task_and_plan, state):
    task, plan = task_and_plan
    pre = service.capture(task, plan, "pre_fix")

    # 修复后：页面元素补上、health 恢复 200；但 other 接口被改挂，error-banner 依旧缺失
    state.update(html=HTML_FIXED, health=200, other=500)
    post = service.capture(task, plan, "post_fix")

    diff = PerceptionService.compare(pre, post)
    resolved = {(e.dimension, e.kind, e.key) for e in diff.resolved}
    persistent = {(e.dimension, e.kind, e.key) for e in diff.persistent}
    introduced = {(e.dimension, e.kind, e.key) for e in diff.introduced}

    assert ("page", "element_missing", "#submit-btn") in resolved
    assert ("page", "interaction_failed", "#submit-btn") in resolved
    assert ("api", "status_error", "GET /api/health") in resolved
    assert persistent == {("page", "element_missing", "#error-banner")}
    assert introduced == {("api", "status_error", "GET /api/other")}
    assert not diff.fixed
    assert "已消除" in diff.summary and "仍存在" in diff.summary and "新增" in diff.summary

    # 全部修复后 fixed=True
    state.update(other=200, html=HTML_FIXED.replace("</body>",
                   '<div id="error-banner">ok</div></body>'))
    post2 = service.capture(task, plan, "post_fix")
    diff2 = PerceptionService.compare(pre, post2)
    assert diff2.fixed
    assert not diff2.persistent and not diff2.introduced

    # 快照可从库中读回
    loaded = service.load_snapshot(task.id, "pre_fix")
    assert loaded is not None and loaded.task_id == task.id
