"""提示词模板：集中管理、版本化（设计文档 2.2 / 十）。

模板为 Python str.format 格式，占位符见各模板注释。
"""

from __future__ import annotations

from importlib import resources

# 模板版本号：变更模板时必须升版本，fix_record.prompt_version 依此留痕
PROMPT_VERSIONS = {
    "completeness": "v1",
    "planning": "v3",  # 四段式 + fix_approach（§9.5）+ 技能库动态段（§8）
    "scoring": "v1",
    "scoring_v2": "v1",  # 评分 v2 引擎薄壳（Spec 04 §8.2，rubric 直传）
    "code_evidence": "v1",  # 评分 v2 代码实证（Spec 04 §8.6）
    "fixing": "v1",
    "fixing_retry": "v1",
    "failure_analysis": "v1",
    "experience_digest": "v1",  # 成功分支 LLM 归因与分类（Spec 08 §7 已知限制修复）
}


def load_prompt(name: str) -> str:
    """按名称加载模板（如 completeness -> templates/completeness_v1.md）。"""
    version = PROMPT_VERSIONS[name]
    ref = resources.files("autobugfixer.prompts.templates").joinpath(f"{name}_{version}.md")
    return ref.read_text(encoding="utf-8")


def prompt_version(name: str) -> str:
    """返回模板的版本标识（如 "fixing:v1"），供审计留痕。"""
    return f"{name}:{PROMPT_VERSIONS[name]}"
