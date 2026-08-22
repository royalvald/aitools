"""通知适配器（PRD 第八章：介入请求推送至对应角色）。

首期实现日志通知；企微/钉钉等 IM 适配器按插件接入。
"""

from __future__ import annotations

import logging
from typing import Protocol

from pydantic import BaseModel

logger = logging.getLogger(__name__)


class NoticeMessage(BaseModel):
    """通知消息载体：标题 + 内容 + 处理入口链接。"""

    title: str
    content: str
    link: str = ""  # 控制台处理入口链接


class Notifier(Protocol):
    """通知器协议：按角色推送介入消息。"""

    def send(self, role: str, message: NoticeMessage) -> None:
        """向指定角色发送通知。"""
        ...


class LogNotifier:
    """日志通知实现（默认）。"""

    def send(self, role: str, message: NoticeMessage) -> None:
        """以 INFO 日志输出通知（默认实现，不依赖外部服务）。"""
        logger.info("[NOTIFY -> %s] %s | %s | %s", role, message.title, message.content, message.link)
