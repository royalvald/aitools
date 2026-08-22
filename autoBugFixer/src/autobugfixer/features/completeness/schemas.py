"""完整性分析结构化输出 Schema（FR-PRE-02）。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class CompletenessEval(BaseModel):
    """完整性评估结论（FR-PRE-02）。"""

    complete: bool
    missing: list[str] = Field(default_factory=list)  # 缺失项清单
    suggestions: list[str] = Field(default_factory=list)  # 建议补充内容
