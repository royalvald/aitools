"""审计服务：追加写，不落更新（设计文档 5.1 audit_log）。

关键动作处调用：状态迁移、命令执行、介入创建/回写、LLM 调用计量、注入检测告警。
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import AuditLog


class AuditService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def log(self, action: str, target: str = "", detail: dict | None = None,
            actor: str = "system", task_id: int | None = None) -> AuditLog:
        entry = AuditLog(task_id=task_id, actor=actor, action=action,
                         target=target, detail=detail or {})
        self.session.add(entry)
        self.session.flush()
        return entry
