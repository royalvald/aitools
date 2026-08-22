"""IM 通知适配器：企业微信/钉钉群机器人 webhook（PRD 第八章：介入请求推送）。

【暂不使用】本模块当前标记为暂不使用：代码保留，默认通知走 LogNotifier，
仅显式配置 notifier_type=im 时才会激活；后续启用时移除本标记。

httpx 惰性使用；发送失败记日志不阻断流程。
"""

from __future__ import annotations

import json
import logging

from autobugfixer.features.intervention.notifier import NoticeMessage

logger = logging.getLogger(__name__)


class IMNotifier:
    """群机器人 webhook 通知器。

    :param webhook_url: 机器人 webhook 地址（配置注入）；
    :param kind: wecom（企业微信 markdown）/ dingtalk（钉钉 markdown）；
    :param client: 可注入 httpx.Client（测试用 MockTransport）。
    """

    def __init__(self, webhook_url: str, kind: str = "wecom", client=None,
                 timeout: float = 10.0) -> None:
        self.webhook_url = webhook_url
        self.kind = kind
        self._client = client
        self.timeout = timeout

    def _payload(self, role: str, message: NoticeMessage) -> dict:
        text = f"**{message.title}**\n> 角色: {role}\n> {message.content}"
        if message.link:
            text += f"\n> 处理入口: {message.link}"
        if self.kind == "dingtalk":
            return {"msgtype": "markdown",
                    "markdown": {"title": message.title, "text": text}}
        return {"msgtype": "markdown", "markdown": {"content": text}}  # wecom

    def send(self, role: str, message: NoticeMessage) -> None:
        """推送 markdown 消息到群机器人；失败仅记日志，不阻断主流程。"""
        try:
            client = self._client
            if client is None:
                import httpx  # 惰性导入

                client = httpx.Client(timeout=self.timeout)
                resp = client.post(self.webhook_url,
                                   content=json.dumps(self._payload(role, message)),
                                   headers={"Content-Type": "application/json"})
                client.close()
            else:
                resp = client.post(self.webhook_url, json=self._payload(role, message))
            if resp.status_code >= 400:
                logger.warning("IM 通知发送失败: HTTP %s %s", resp.status_code,
                               resp.text[:200])
        except Exception as exc:  # 通知失败不阻断流程
            logger.warning("IM 通知发送异常（已忽略）: %s", exc)


def build_notifier(settings, client=None):
    """按配置构建通知器：im 且配置了 webhook -> IMNotifier，否则日志通知器。"""
    from autobugfixer.features.intervention.notifier import LogNotifier

    if settings.notifier_type == "im" and settings.im_webhook_url:
        return IMNotifier(settings.im_webhook_url, kind=settings.im_kind, client=client)
    return LogNotifier()
