"""端到端测试（11.6）：Fake LLM + Mock 平台 + LocalExecutor 全链路。

链路：拉 Bug -> 完整性分析 -> 验证方案（DSL）-> 评分准入 -> 修复 agent
-> 环境锁 + 部署 -> DSL 解释验证通过 -> 经验沉淀 -> CLOSED。
"""

import json
from pathlib import Path

from sqlalchemy import select

from autobugfixer.models import (
    AuditLog,
    Experience,
    FixRecord,
    LLMUsage,
    TaskStateHistory,
    VerificationPlan,
    VerifyRecord,
)
from autobugfixer.pipeline.state import TaskState


def test_end_to_end_full_pipeline(make_orchestrator, task_id, session_factory,
                                  platform, settings):
    orchestrator = make_orchestrator()
    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.CLOSED

    # 部署后的仿真环境：修复产物已生效
    health = Path(settings.env_root) / "api" / "health.json"
    assert json.loads(health.read_text(encoding="utf-8"))["status"] == "ok"

    with session_factory() as s:
        # 状态历史完整覆盖全链路（断点续跑/审计回放依据）
        states = [h.to_state for h in s.scalars(select(TaskStateHistory).where(
            TaskStateHistory.task_id == task_id).order_by(TaskStateHistory.id)).all()]
        for expected in ["DISCOVERED", "ANALYZING", "PLANNING", "SCORED",
                         "FIXING", "DEPLOYING", "VERIFYING", "LEARNING", "CLOSED"]:
            assert expected in states, f"缺少状态: {expected}"

        # 验证方案是 DSL 结构化输出
        plan = s.scalar(select(VerificationPlan).where(VerificationPlan.task_id == task_id))
        assert plan.dsl_version == "1.0"
        assert plan.steps[0]["action"] == "call_api"

        # 修复留痕：受控分支 + diff + prompt 快照
        fix = s.scalar(select(FixRecord).where(FixRecord.task_id == task_id))
        assert fix.branch == "autofix/BUG-T001"
        assert "api/health.json" in fix.changed_files
        assert "fail" in fix.diff and "ok" in fix.diff
        assert fix.prompt_snapshot

        # 验证结论通过且有逐步证据
        verify = s.scalar(select(VerifyRecord).where(VerifyRecord.task_id == task_id))
        assert verify.conclusion == "passed"
        assert all(step["passed"] for step in verify.step_results)

        # 经验已沉淀
        exp = s.scalar(select(Experience))
        assert exp is not None and task_id in exp.source_task_ids

        # LLM 调用已计量
        usages = s.scalars(select(LLMUsage).where(LLMUsage.task_id == task_id)).all()
        stages = {u.stage for u in usages}
        assert {"completeness", "planning", "scoring", "fixing"} <= stages
        assert all(u.tokens_in > 0 for u in usages)

        # 关键动作审计留痕
        actions = {a.action for a in s.scalars(
            select(AuditLog).where(AuditLog.task_id == task_id)).all()}
        assert {"state_transition", "cmd_exec", "env_lock_acquire",
                "env_lock_release", "llm_call", "verify", "fix_attempt"} <= actions

    # 缺陷平台已回写关闭
    assert any(patch.status == "已关闭" for _, patch in platform.updates)


def test_env_lock_released_after_pipeline(make_orchestrator, task_id, session_factory):
    """临界区结束后环境锁必须释放（11.1）。"""
    from autobugfixer.models import EnvLock

    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED
    with session_factory() as s:
        assert s.scalars(select(EnvLock)).all() == []
