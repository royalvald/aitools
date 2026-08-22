"""验证方案生成结构化输出 Schema（FR-PRE-03 + 11.4 DSL + Spec 03 §9）。"""

from __future__ import annotations

from pydantic import BaseModel, Field, model_validator

from autobugfixer.common.dsl import DSLStep

# 断言类动作（Spec 03 §9.2：方案至少含 1 条断言）
ASSERT_ACTIONS = {"assert_response", "assert_element", "assert_db"}


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


class DSLRetryError(ValueError):
    """DSL Schema 校验失败（触发重新生成）。"""
