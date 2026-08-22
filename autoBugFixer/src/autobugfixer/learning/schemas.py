"""经验沉淀结构化输出 Schema（FR-MEM-01/02）。"""

from __future__ import annotations

from pydantic import BaseModel


class FailureAnalysis(BaseModel):
    """失败复盘（FR-MEM-02）：不适用场景说明 + 人工讨论议题。"""

    condition_desc: str = ""  # 何种条件下系统不适用
    reason: str = ""  # 失败原因分析
    discussion_topic: str = ""  # 人工讨论议题


class ExperienceDigest(BaseModel):
    """成功分支经验归因（Spec 08 §7：LLM 分类 + 根因沉淀）。"""

    category: str = ""  # 分类（空则回退关键词规则）
    root_cause_pattern: str = ""  # 根因模式（空则不覆盖库内旧值）
