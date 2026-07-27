"""通知适配器（PRD 第八章：介入请求推送至对应角色）。

首期实现日志通知；企微/钉钉等 IM 适配器按插件接入。
"""

from __future__ import annotations

import logging
from typing import Protocol

from pydantic import BaseModel

logger = logging.getLogger(__name__)


class NoticeMessage(BaseModel):
    title: str
    content: str
    link: str = ""  # 控制台处理入口链接


class Notifier(Protocol):
    def send(self, role: str, message: NoticeMessage) -> None: ...


class LogNotifier:
    """日志通知实现（默认）。"""

    def send(self, role: str, message: NoticeMessage) -> None:
        logger.info("[NOTIFY -> %s] %s | %s | %s", role, message.title, message.content, message.link)
