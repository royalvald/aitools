"""知识库沉淀输出（FR-SYS-03）：经验库渲染为分类组织的 Markdown，导出前脱敏。"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from autobugfixer.common.core.models import Experience
from autobugfixer.common.security.redact import redact_sensitive


def render_markdown(session: Session) -> str:
    """把经验库渲染为分类组织的 Markdown 知识文档。"""
    entries = list(session.scalars(select(Experience).where(
        Experience.status == "active").order_by(Experience.category, Experience.id)).all())
    lines = [
        "# autobugfixer 修复经验知识库",
        "",
        f"> 导出时间: {datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC}，共 {len(entries)} 条",
        "",
    ]
    current_category = None
    for e in entries:
        if e.category != current_category:
            current_category = e.category
            lines += [f"## {current_category}", ""]
        lines += [
            f"### {e.problem_signature}",
            "",
            f"- 症状: {e.symptoms or '-'}",
            f"- 修复方法: {e.fix_pattern or '-'}",
            f"- 验证要点: {e.verification_points or '-'}",
            f"- 适用条件: {e.applicable_conditions or '-'}",
            f"- 命中次数: {e.hit_count}，来源任务: {e.source_task_ids}",
            "",
        ]
    # 导出前脱敏：剔除凭据类敏感串
    return redact_sensitive("\n".join(lines))
