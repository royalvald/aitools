"""LLM 结构化输出的 Pydantic Schema（11.4：以 JSON Schema 约束 LLM 输出）。"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from .dsl import DSLStep


class CompletenessEval(BaseModel):
    """完整性评估结论（FR-PRE-02）。"""

    complete: bool
    missing: list[str] = Field(default_factory=list)  # 缺失项清单
    suggestions: list[str] = Field(default_factory=list)  # 建议补充内容


class PlanOutput(BaseModel):
    """回归验证方案（FR-PRE-03 + 11.4 DSL）。"""

    env_requirements: str = ""
    steps: list[DSLStep]
    expected_results: list[str] = Field(default_factory=list)
    function_points: list[str] = Field(default_factory=list)
    regression_scope: str = ""


class ScoreOutput(BaseModel):
    """三维难度评分（FR-PRE-04），各维度 0-100。"""

    fix_difficulty: float = Field(ge=0, le=100)  # 解决难度
    verify_difficulty: float = Field(ge=0, le=100)  # 回归验证难度
    change_scale: float = Field(ge=0, le=100)  # 改动项规模
    rationale: str = ""  # 评分理由（可解释）


class FailureAnalysis(BaseModel):
    """失败复盘（FR-MEM-02）：不适用场景说明 + 人工讨论议题。"""

    condition_desc: str = ""  # 何种条件下系统不适用
    reason: str = ""  # 失败原因分析
    discussion_topic: str = ""  # 人工讨论议题


class DSLRetryError(ValueError):
    """DSL Schema 校验失败（触发重新生成）。"""
