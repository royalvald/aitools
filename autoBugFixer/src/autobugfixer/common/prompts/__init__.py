"""提示词模板：集中管理、版本化（设计文档 2.2 / 十）。

模板为 Python str.format 格式，占位符见各模板注释。
"""

from __future__ import annotations

from importlib import resources

# 模板版本号：变更模板时必须升版本，fix_record.prompt_version 依此留痕
PROMPT_VERSIONS = {
    "completeness": "v2",  # 逐项判据 + 正反例 + 输出质量要求（few-shot/grounding）
    "repo_profile": "v1",  # 关联仓库逐个 LLM 画像（Spec 02 §9，结果随 bug_repo 持久化）
    "planning": "v4",  # v3 机制不动：示例标签化 + 反例 + 步骤锚定 Bug 原文 + 仓库画像段
    "scoring": "v2",  # 三维锚点区间 + rationale 可反推要求（v1 引擎默认路径）
    "scoring_v2": "v2",  # 评分 v2 引擎薄壳：判定流程分步 + 证据引用要求（rubric 直传不变）
    "code_evidence": "v2",  # 防幻觉约束（路径取片段原文）+ 改动面枚举
    "fixing": "v2",  # 五步工作流 + 硬性约束 + 自检清单 + 结构化修复说明（借鉴 SWE-agent/Agentless）
    "fixing_retry": "v2",  # 增量：重试推理链（读证据->复盘->审视工作区->换角度）
    "failure_analysis": "v2",  # 失败模式归类 + condition_desc 可判定写法
    "experience_digest": "v2",  # 成功分支：交叉印证 + 模式化表达 + 分类判据
}


def load_prompt(name: str) -> str:
    """按名称加载模板（如 completeness -> templates/completeness_v1.md）。"""
    version = PROMPT_VERSIONS[name]
    ref = resources.files("autobugfixer.common.prompts.templates").joinpath(f"{name}_{version}.md")
    return ref.read_text(encoding="utf-8")


def prompt_version(name: str) -> str:
    """返回模板的版本标识（如 "fixing:v1"），供审计留痕。"""
    return f"{name}:{PROMPT_VERSIONS[name]}"
