"""IM 通知适配器与平台状态回写测试。"""

import httpx
from sqlalchemy import select

from autobugfixer.features.intervention.notifier import LogNotifier, NoticeMessage
from autobugfixer.features.intervention.notifier_im import IMNotifier, build_notifier
from autobugfixer.common.core.models import AuditLog, Task
from autobugfixer.common.core.state import TaskState


# ---------- IM 通知器 ----------

def test_im_notifier_wecom_payload():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"errcode": 0})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    notifier = IMNotifier("https://qyapi.weixin.qq.com/bot/send?key=xxx",
                          kind="wecom", client=client)
    notifier.send("tester", NoticeMessage(title="介入请求", content="请补充信息",
                                          link="/interventions/1"))
    import json

    payload = json.loads(requests[0].content)
    assert payload["msgtype"] == "markdown"
    assert "介入请求" in payload["markdown"]["content"]
    assert "/interventions/1" in payload["markdown"]["content"]


def test_im_notifier_dingtalk_payload():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"errcode": 0})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    notifier = IMNotifier("https://oapi.dingtalk.com/robot/send?token=xxx",
                          kind="dingtalk", client=client)
    notifier.send("dev", NoticeMessage(title="部署告警", content="回滚完成"))
    import json

    payload = json.loads(requests[0].content)
    assert payload["msgtype"] == "markdown"
    assert payload["markdown"]["title"] == "部署告警"
    assert "回滚完成" in payload["markdown"]["text"]


def test_im_notifier_failure_swallowed():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="server error")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    notifier = IMNotifier("https://example.com/hook", client=client)
    notifier.send("ops", NoticeMessage(title="t", content="c"))  # 不抛异常


def test_build_notifier_by_config(settings):
    assert isinstance(build_notifier(settings), LogNotifier)  # 默认 log
    settings.notifier_type = "im"
    settings.im_webhook_url = "https://example.com/hook"
    assert isinstance(build_notifier(settings), IMNotifier)


# ---------- 平台状态回写 ----------

def test_writeback_on_key_states(make_orchestrator, task_id, platform, environment):
    """关键状态迁移触发平台回写（status_map）。"""
    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED
    statuses = [patch.status for _, patch in platform.updates]
    assert "已关闭" in statuses  # CLOSED -> 已关闭


def test_writeback_failure_not_blocking(make_orchestrator, task_id, platform,
                                        session_factory, environment):
    """回写失败重试一次并告警，主流程不受影响。"""
    calls = {"n": 0}

    def boom(bug_id, patch):
        calls["n"] += 1
        raise ConnectionError("platform down")

    platform.update_bug = boom
    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED
    assert calls["n"] >= 2  # 首次 + 重试
    with session_factory() as s:
        actions = [a.action for a in s.scalars(select(AuditLog)).all()]
        assert "platform_writeback_failed" in actions
