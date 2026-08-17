"""LLM 结构化输出的 Pydantic Schema（11.4：以 JSON Schema 约束 LLM 输出）。"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator, model_validator

from .dsl import DSLStep

# 断言类动作（Spec 03 §9.2：方案至少含 1 条断言）
ASSERT_ACTIONS = {"assert_response", "assert_element", "assert_db"}


class CompletenessEval(BaseModel):
    """完整性评估结论（FR-PRE-02）。"""

    complete: bool
    missing: list[str] = Field(default_factory=list)  # 缺失项清单
    suggestions: list[str] = Field(default_factory=list)  # 建议补充内容


class FixApproach(BaseModel):
    """修复思路大纲（Spec 03 §9.4，P1）：供评分与修复阶段消费的提示性大纲。

    大纲是提示不是约束，修复中可依实际代码偏离。
    """

    locate_hints: list[str] = Field(default_factory=list)  # 可疑点定位线索
    change_files: list[str] = Field(default_factory=list)  # 拟改动文件/模块清单
    strategy: str = ""  # 修复策略概述


class ProposedSkill(BaseModel):
    """方案生成时提议的组合校验技能（Spec 03 §8）。

    步骤模板仅含 9 基础动作、支持 ``{param}`` 占位（同样过 DSLStep 词表/
    必填参数校验链）；首次提议仅内联展开落库，验证通过后蒸馏入库。
    """

    name: str = Field(min_length=1, max_length=100)
    params: list[str] = Field(default_factory=list)  # 参数签名
    desc: str = ""
    steps: list[DSLStep]


class PlanOutput(BaseModel):
    """回归验证方案（FR-PRE-03 + 11.4 DSL + Spec 03 §9 四段式深度要求）。"""

    env_requirements: str = ""
    steps: list[DSLStep]
    expected_results: list[str] = Field(default_factory=list)
    function_points: list[str] = Field(default_factory=list)
    regression_scope: str = ""
    fix_approach: FixApproach | None = None  # 修复思路大纲（Spec 03 §9.4）
    proposed_skills: list[ProposedSkill] = Field(default_factory=list)  # 提议技能（Spec 03 §8）

    @model_validator(mode="after")
    def steps_must_form_complete_flow(self) -> "PlanOutput":
        """四段式流程硬校验（Spec 03 §9.2）：S1-S3 各至少 1 步的下限表达。

        - steps 数量 >= 3；
        - 至少 1 条 assert_* 断言动作（无断言的验证不构成验证）；
        - S4（交叉验证）适用性由模板引导 LLM 判断，不做硬校验（避免强行凑步）。
        违规由 Gateway 按既有重试链重新生成，重试耗尽 -> FAILED。
        """
        if len(self.steps) < 3:
            raise ValueError(
                f"验证方案步骤不足：至少 3 步（前置准备/触发执行/结果断言），当前 {len(self.steps)} 步")
        if not any(s.action in ASSERT_ACTIONS for s in self.steps):
            raise ValueError("验证方案缺少断言动作（assert_response/assert_element/assert_db 至少 1 条）")
        return self


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
    rationale；分数映射由本地规则（pipeline/scoring_v2.py）完成。
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


class FailureAnalysis(BaseModel):
    """失败复盘（FR-MEM-02）：不适用场景说明 + 人工讨论议题。"""

    condition_desc: str = ""  # 何种条件下系统不适用
    reason: str = ""  # 失败原因分析
    discussion_topic: str = ""  # 人工讨论议题


class ExperienceDigest(BaseModel):
    """成功分支经验归因（Spec 08 §7：LLM 分类 + 根因沉淀）。"""

    category: str = ""  # 分类（空则回退关键词规则）
    root_cause_pattern: str = ""  # 根因模式（空则不覆盖库内旧值）


class DSLRetryError(ValueError):
    """DSL Schema 校验失败（触发重新生成）。"""
