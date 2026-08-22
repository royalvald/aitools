"""公共状态迁移入口（状态机契约统一执行点）。

所有改变 ``task.state`` 的代码必须经 :func:`transition_task`：合法性断言 +
状态写入 + closed_at 维护 + 状态历史 + 审计留痕 + 可选平台回写钩子（11.7）。
绕过本函数直写 ``task.state`` 会破坏时间线回放与审计完整性（历史缺失的迁移
在回放视图里表现为"状态跳变"）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable

from sqlalchemy.orm import Session

from .audit import AuditService
from .models import Task, TaskStateHistory
from .state import TaskState, assert_transition


def transition_task(
    session: Session,
    task: Task,
    to_state: TaskState,
    *,
    stage: str,
    message: str = "",
    audit: AuditService | None = None,
    writeback: Callable[[str], None] | None = None,
) -> Task:
    """执行一次合法状态迁移并完整留痕（历史 + 审计 + 可选回写）。

    - 非法迁移抛 ``IllegalTransitionError``（调用方不应捕获吞掉）；
    - 迁移到 CLOSED 时同步写 ``task.closed_at``（Spec 08 §3.5 口径）；
    - ``stage`` 同时写入 ``current_stage`` 与历史/审计，标记迁移发起方
      （stage 插件名 / scheduler / api / intervention / ingest）。
    """
    from_state = TaskState(task.state)
    assert_transition(from_state, to_state)
    task.state = to_state.value
    task.current_stage = stage
    if to_state == TaskState.CLOSED:
        task.closed_at = datetime.now(timezone.utc)
    session.add(TaskStateHistory(
        task_id=task.id, from_state=from_state.value, to_state=to_state.value,
        stage=stage, message=message,
    ))
    (audit or AuditService(session)).log(
        action="state_transition", target=f"task:{task.id}",
        detail={"from": from_state.value, "to": to_state.value,
                "stage": stage, "message": message},
        task_id=task.id,
    )
    if writeback is not None:
        writeback(to_state.value)
    return task
