"""Bug 文本块拼装与注入防护（11.2 输入侧，各分析/修复阶段共用）。"""

from __future__ import annotations

from autobugfixer.common.security.injection import detect_injection, wrap_untrusted
from .stage import TaskContext

# 单字段长度上限：超大日志/堆栈粘贴进工单会把每个阶段的 prompt 全部撑爆
# （completeness -> planning -> scoring -> fixing 反复注入），统一在入口截断
FIELD_LIMITS = {
    "title": 500,
    "description": 4000,
    "repro_steps": 4000,
    "expected": 2000,
    "actual": 2000,
    "env_version": 500,
}


def _clip(value: str, limit: int) -> str:
    """超长字段截断并标注原始长度（保留截断可见性，下游可知信息不全）。"""
    text = value or ""
    if len(text) <= limit:
        return text
    return text[:limit] + f"……[字段超长已截断，原始 {len(text)} 字符]"


def build_bug_block(ctx: TaskContext) -> str:
    """拼装 Bug 结构化文本并做注入防护（11.2 输入侧）：截断 + 包裹边界 + 模式检测留痕。"""
    bug = ctx.bug
    text = (
        f"标题: {_clip(bug.title, FIELD_LIMITS['title'])}\n"
        f"描述: {_clip(bug.description, FIELD_LIMITS['description'])}\n"
        f"复现步骤: {_clip(bug.repro_steps, FIELD_LIMITS['repro_steps'])}\n"
        f"期望结果: {_clip(bug.expected, FIELD_LIMITS['expected'])}\n"
        f"实际结果: {_clip(bug.actual, FIELD_LIMITS['actual'])}\n"
        f"环境版本: {_clip(bug.env_version, FIELD_LIMITS['env_version'])}\n"
        f"影响模块: {','.join(bug.affected_modules) or '未标注'}"
    )
    report = detect_injection(text)
    if report.flagged:  # 不阻断，留痕告警
        ctx.audit.log(action="injection_detected", target=f"bug:{bug.platform_bug_id}",
                      detail={"matched": report.matched_patterns}, task_id=ctx.task.id)
    return wrap_untrusted(text)
