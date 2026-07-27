"""Stage 插件接口（设计文档 3.2，FR-SYS-01）。

所有阶段实现统一 Stage 协议，通过 TaskContext 传递数据，新增阶段只需注册。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Protocol

from pydantic import BaseModel

from .state import TaskState

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from ..adapters.bug_platform import BugPlatformAdapter
    from ..adapters.env_executor import EnvExecutor
    from ..adapters.notifier import Notifier
    from ..config import Settings
    from ..models import BugTicket, Task
    from ..services.audit import AuditService
    from ..services.env_lock import EnvLockService
    from ..services.intervention import InterventionService
    from ..services.llm_gateway import LLMGateway


class InterventionRequest(BaseModel):
    """Stage 请求人工介入的载体。"""

    type: str  # info_supplement / plan_confirm / discussion / optimization
    title: str
    context: dict = {}
    assignee_role: str = "developer"
    wait_state: TaskState  # 任务应进入的阻塞态


class StageResult(BaseModel):
    status: Literal["success", "need_intervention", "retry", "failed"]
    next_state: TaskState | None = None
    artifacts: dict = {}  # 本阶段产出（方案、差异、证据等）
    intervention: InterventionRequest | None = None
    message: str = ""


@dataclass
class TaskContext:
    """任务上下文：承载标准化 Bug、各阶段产出与全部服务句柄。

    只传结构化摘要，大对象落库后按 id 查询（对应"长流程上下文膨胀"对策）。
    """

    task: "Task"
    bug: "BugTicket"
    session: "Session"
    settings: "Settings"
    llm: "LLMGateway"
    platform: "BugPlatformAdapter"
    executor: "EnvExecutor"
    notifier: "Notifier"
    audit: "AuditService"
    interventions: "InterventionService"
    env_locks: "EnvLockService"
    data: dict[str, Any] = field(default_factory=dict)  # 阶段间临时传递的小对象
    # 可选接线：修复通道（默认 None 走 ctx.llm 的 LangChain 通道）、三维感知服务
    fix_channel: Any = None
    perception: Any = None

    @property
    def attempt(self) -> int:
        """当前修复尝试次数（1 起始）。"""
        return self.task.retry_count + 1


class Stage(Protocol):
    name: str

    def run(self, ctx: TaskContext) -> StageResult: ...
