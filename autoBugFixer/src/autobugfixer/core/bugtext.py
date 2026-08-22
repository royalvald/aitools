"""Bug 文本块拼装与注入防护（11.2 输入侧，各分析/修复阶段共用）。"""

from __future__ import annotations

from ..security.injection import detect_injection, wrap_untrusted
from .stage import TaskContext


def build_bug_block(ctx: TaskContext) -> str:
    """拼装 Bug 结构化文本并做注入防护（11.2 输入侧）：包裹边界 + 模式检测留痕。"""
    bug = ctx.bug
    text = (
        f"标题: {bug.title}\n描述: {bug.description}\n复现步骤: {bug.repro_steps}\n"
        f"期望结果: {bug.expected}\n实际结果: {bug.actual}\n环境版本: {bug.env_version}\n"
        f"影响模块: {','.join(bug.affected_modules) or '未标注'}"
    )
    report = detect_injection(text)
    if report.flagged:  # 不阻断，留痕告警
        ctx.audit.log(action="injection_detected", target=f"bug:{bug.platform_bug_id}",
                      detail={"matched": report.matched_patterns}, task_id=ctx.task.id)
    return wrap_untrusted(text)
