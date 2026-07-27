"""任务状态机（对应设计文档 3.1）。

状态即断点：每次迁移写入 task_state_history，worker 按当前状态路由到对应 Stage。
"""

from __future__ import annotations

from enum import StrEnum


class TaskState(StrEnum):
    DISCOVERED = "DISCOVERED"  # 适配器拉取/接收 Bug，完成标准化
    ANALYZING = "ANALYZING"  # 完整性分析
    WAIT_INFO = "WAIT_INFO"  # 介入：待人工补充信息
    PLANNING = "PLANNING"  # 生成验证方案
    WAIT_PLAN = "WAIT_PLAN"  # 介入：待人工确认方案
    SCORED = "SCORED"  # 评分排序入队
    MANUAL = "MANUAL"  # 转人工处理（终态，可人工重新触发）
    FIXING = "FIXING"  # AI 修复
    DEPLOYING = "DEPLOYING"  # 打包更新启停
    WAIT_ENV = "WAIT_ENV"  # 等待环境锁
    VERIFYING = "VERIFYING"  # 按方案验证
    LEARNING = "LEARNING"  # 经验沉淀
    WAIT_DISCUSS = "WAIT_DISCUSS"  # 介入：失败讨论
    CLOSED = "CLOSED"  # 已关闭（终态）
    FAILED = "FAILED"  # 失败（可人工重新触发，从断点续跑）
    CANCELLED = "CANCELLED"  # 已取消（终态）


# 合法迁移表：key -> 允许迁移到的状态集合
LEGAL_TRANSITIONS: dict[TaskState, set[TaskState]] = {
    TaskState.DISCOVERED: {TaskState.ANALYZING, TaskState.CANCELLED},
    TaskState.ANALYZING: {TaskState.WAIT_INFO, TaskState.PLANNING, TaskState.MANUAL, TaskState.FAILED, TaskState.CANCELLED},
    TaskState.WAIT_INFO: {TaskState.ANALYZING, TaskState.CANCELLED},  # 补充完成重新分析
    TaskState.PLANNING: {TaskState.WAIT_PLAN, TaskState.SCORED, TaskState.FAILED, TaskState.CANCELLED},
    TaskState.WAIT_PLAN: {TaskState.PLANNING, TaskState.SCORED, TaskState.CANCELLED},  # 确认/调整后继续
    TaskState.SCORED: {TaskState.MANUAL, TaskState.FIXING, TaskState.FAILED, TaskState.CANCELLED},
    TaskState.MANUAL: {TaskState.ANALYZING, TaskState.FIXING, TaskState.CANCELLED},  # 人工重新触发
    TaskState.FIXING: {TaskState.DEPLOYING, TaskState.FAILED, TaskState.MANUAL, TaskState.LEARNING, TaskState.CANCELLED},
    TaskState.DEPLOYING: {TaskState.VERIFYING, TaskState.WAIT_ENV, TaskState.FIXING, TaskState.FAILED, TaskState.CANCELLED},
    TaskState.WAIT_ENV: {TaskState.DEPLOYING, TaskState.CANCELLED},  # 锁释放后被唤醒
    TaskState.VERIFYING: {TaskState.FIXING, TaskState.LEARNING, TaskState.FAILED, TaskState.CANCELLED},
    TaskState.LEARNING: {TaskState.CLOSED, TaskState.WAIT_DISCUSS, TaskState.FAILED, TaskState.CANCELLED},
    TaskState.WAIT_DISCUSS: {TaskState.MANUAL, TaskState.CLOSED, TaskState.FIXING, TaskState.CANCELLED},
    TaskState.FAILED: {TaskState.ANALYZING, TaskState.FIXING, TaskState.DEPLOYING, TaskState.CANCELLED},  # 断点续跑
    TaskState.CLOSED: set(),
    TaskState.CANCELLED: set(),
}

# 阻塞态：等待人工/环境，Orchestrator 跑到这些状态即停
BLOCKING_STATES: set[TaskState] = {TaskState.WAIT_INFO, TaskState.WAIT_PLAN, TaskState.WAIT_ENV, TaskState.WAIT_DISCUSS}

# 终态
TERMINAL_STATES: set[TaskState] = {TaskState.CLOSED, TaskState.MANUAL, TaskState.CANCELLED}


class IllegalTransitionError(Exception):
    """非法状态迁移。"""


def can_transition(from_state: TaskState | str, to_state: TaskState | str) -> bool:
    return TaskState(to_state) in LEGAL_TRANSITIONS.get(TaskState(from_state), set())


def assert_transition(from_state: TaskState | str, to_state: TaskState | str) -> None:
    if not can_transition(from_state, to_state):
        raise IllegalTransitionError(f"非法状态迁移: {from_state} -> {to_state}")
