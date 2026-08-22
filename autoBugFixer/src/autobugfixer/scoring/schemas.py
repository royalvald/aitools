"""难度评分结构化输出 Schema（FR-PRE-04 + Spec 04 §8 v2 判定表单）。"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


class ScoreOutput(BaseModel):
    """三维难度评分（FR-PRE-04），各维度 0-100。"""

    fix_difficulty: float = Field(ge=0, le=100)  # 解决难度
    verify_difficulty: float = Field(ge=0, le=100)  # 回归验证难度
    change_scale: float = Field(ge=0, le=100)  # 改动项规模
    rationale: str = ""  # 评分理由（可解释）


# 评分 v2（Spec 04 §8.5）：LLM 全程不产出分数，只做归类与证据判定。
# 合法类型 ID 与 rubric 类型先验表保持一致（prompts/rubrics/scoring_rubric_v1.md）。
V2_BUG_TYPES = {"copy_text", "param_check", "single_logic", "cross_module", "data_arch"}


class LocateSignals(BaseModel):
    """定位证据信号（Spec 04 §8.5 locate_signals）。"""

    has_stack: bool = False  # 含堆栈/明确代码位置
    has_location_desc: bool = False  # 有现象描述可推断位置


class CodeEvidence(BaseModel):
    """代码实证结论（Spec 04 §8.6，复杂类型触发的第二次调用产出）。"""

    triggered: bool = False  # 是否定位到疑似问题点
    suspected_files: list[str] = Field(default_factory=list)
    change_scale_estimate: str = ""


class JudgmentForm(BaseModel):
    """评分 v2 判定表单（Spec 04 §8.5，替代 ScoreOutput 的测量职责）。

    每个分数可反推到"哪个类型区间 + 命中哪些因子"——替代 v1 不可校验的自由文本
    rationale；分数映射由本地规则（scoring/v2.py）完成。
    """

    bug_type: str
    type_evidence: str = ""  # 归类证据（作为 score_detail.rationale 留痕）
    factors_hit: list[str] = Field(default_factory=list)  # 命中的 ai 类因子 ID
    factor_evidence: dict[str, str] = Field(default_factory=dict)
    locate_signals: LocateSignals = Field(default_factory=LocateSignals)
    code_evidence: CodeEvidence = Field(default_factory=CodeEvidence)

    @field_validator("bug_type")
    @classmethod
    def bug_type_must_be_in_rubric(cls, v: str) -> str:
        """类型 ID 必须在 rubric 类型先验表内（越界由 Gateway 重试）。"""
        if v not in V2_BUG_TYPES:
            raise ValueError(f"非法缺陷类型 ID: {v!r}，允许: {sorted(V2_BUG_TYPES)}")
        return v
