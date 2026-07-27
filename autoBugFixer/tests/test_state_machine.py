"""状态机合法/非法迁移测试（设计文档 3.1）。"""

import pytest

from autobugfixer.pipeline.state import (
    IllegalTransitionError,
    TaskState,
    assert_transition,
    can_transition,
)


@pytest.mark.parametrize("from_state,to_state", [
    (TaskState.DISCOVERED, TaskState.ANALYZING),
    (TaskState.ANALYZING, TaskState.WAIT_INFO),
    (TaskState.WAIT_INFO, TaskState.ANALYZING),      # 补充完成重新分析
    (TaskState.PLANNING, TaskState.WAIT_PLAN),
    (TaskState.WAIT_PLAN, TaskState.SCORED),          # 方案确认后进入评分
    (TaskState.SCORED, TaskState.FIXING),
    (TaskState.SCORED, TaskState.MANUAL),             # 超阈值转人工
    (TaskState.FIXING, TaskState.DEPLOYING),
    (TaskState.DEPLOYING, TaskState.WAIT_ENV),        # 等锁挂起
    (TaskState.WAIT_ENV, TaskState.DEPLOYING),        # 锁释放唤醒
    (TaskState.VERIFYING, TaskState.FIXING),          # 重试环
    (TaskState.VERIFYING, TaskState.LEARNING),
    (TaskState.LEARNING, TaskState.CLOSED),
    (TaskState.LEARNING, TaskState.WAIT_DISCUSS),     # 失败分支
    (TaskState.FAILED, TaskState.ANALYZING),          # 断点续跑
])
def test_legal_transitions(from_state, to_state):
    assert can_transition(from_state, to_state)
    assert_transition(from_state, to_state)  # 不抛异常


@pytest.mark.parametrize("from_state,to_state", [
    (TaskState.DISCOVERED, TaskState.FIXING),   # 跳阶段
    (TaskState.CLOSED, TaskState.ANALYZING),    # 终态不可迁移
    (TaskState.CANCELLED, TaskState.FIXING),
    (TaskState.WAIT_INFO, TaskState.DEPLOYING),  # 阻塞态直达部署
    (TaskState.ANALYZING, TaskState.CLOSED),
    (TaskState.SCORED, TaskState.CLOSED),
])
def test_illegal_transitions(from_state, to_state):
    assert not can_transition(from_state, to_state)
    with pytest.raises(IllegalTransitionError):
        assert_transition(from_state, to_state)
