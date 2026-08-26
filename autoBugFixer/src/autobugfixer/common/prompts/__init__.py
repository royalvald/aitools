"""提示词模板：集中管理、版本化（设计文档 2.2 / 十）。

模板为 Python str.format 格式，占位符见各模板注释。
system/user 通道切分：模板内 ``<<<SYSTEM_END>>>`` 标记之前为 system 段
（角色/规则），之后为 user 段（数据 + 输出要求）；标记本身不进入 prompt，
仅插入标记不改变模型可见内容，无需升版本（改措辞才升）。
版本治理：templates/ 只保留各模板的现行版本文件；历史版本随 git 历史保留
（历史 FixRecord/审计记录的 prompt_version 回放查对应提交）。
"""

from __future__ import annotations

from importlib import resources

# 模板版本号：变更模板时必须升版本，fix_record.prompt_version 依此留痕
PROMPT_VERSIONS = {
    "completeness": "v2",  # 逐项判据 + 正反例 + 输出质量要求（few-shot/grounding）
    "repo_profile": "v2",  # 全局仓库事实画像（Spec 02 §9 v2：无 Bug 上下文，挂 repo 表全局复用）
    "planning": "v6",  # v5 + 候选仓库登记表注入 + target_repos 选仓输出（对应关系随方案一并判定）
    "scoring": "v3",  # v2 + 输出 JSON 尾注改为合法形式 + 数据后置
    "scoring_v2": "v2",  # 评分 v2 引擎薄壳：判定流程分步 + 证据引用要求（rubric 直传不变）
    "code_evidence": "v2",  # 防幻觉约束（路径取片段原文）+ 改动面枚举
    "fixing": "v2",  # 五步工作流 + 硬性约束 + 自检清单 + 结构化修复说明（借鉴 SWE-agent/Agentless）
    "fixing_retry": "v2",  # 增量：重试推理链（读证据->复盘->审视工作区->换角度）
    "failure_analysis": "v2",  # 失败模式归类 + condition_desc 可判定写法
    "experience_digest": "v3",  # v2 + 归类/模式化正例（五分类误选防护）
}

# system/user 切分标记（不进入最终 prompt）
SYSTEM_SPLIT_MARK = "<<<SYSTEM_END>>>"


def load_prompt(name: str) -> str:
    """按名称加载模板（如 completeness -> templates/completeness_v2.md）。"""
    version = PROMPT_VERSIONS[name]
    ref = resources.files("autobugfixer.common.prompts.templates").joinpath(f"{name}_{version}.md")
    return ref.read_text(encoding="utf-8")


def split_system_user(text: str) -> tuple[str | None, str]:
    """按标记切分已渲染模板：返回 (system, user)；无标记时整体作为 user。"""
    if SYSTEM_SPLIT_MARK in text:
        system, _, user = text.partition(SYSTEM_SPLIT_MARK)
        return system.strip() + "\n", user.strip()
    return None, text


def render_prompt(name: str, **fields: str) -> tuple[str | None, str]:
    """加载模板、填充占位符并切分通道：返回 (system, user)。

    调用方：system 传 LLMGateway.analyze(system=...)，user 作为 prompt。
    """
    return split_system_user(load_prompt(name).format(**fields))


def prompt_version(name: str) -> str:
    """返回模板的版本标识（如 "fixing:v2"），供审计留痕。"""
    return f"{name}:{PROMPT_VERSIONS[name]}"
