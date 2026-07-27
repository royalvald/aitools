"""提示词模板：集中管理、版本化（设计文档 2.2 / 十）。

模板为 Python str.format 格式，占位符见各模板注释。
"""

from __future__ import annotations

from importlib import resources

# 模板版本号：变更模板时必须升版本，fix_record.prompt_version 依此留痕
PROMPT_VERSIONS = {
    "completeness": "v1",
    "planning": "v1",
    "scoring": "v1",
    "fixing": "v1",
    "fixing_retry": "v1",
    "failure_analysis": "v1",
}


def load_prompt(name: str) -> str:
    """按名称加载模板（如 completeness -> templates/completeness_v1.md）。"""
    version = PROMPT_VERSIONS[name]
    ref = resources.files("autobugfixer.prompts.templates").joinpath(f"{name}_{version}.md")
    return ref.read_text(encoding="utf-8")


def prompt_version(name: str) -> str:
    return f"{name}:{PROMPT_VERSIONS[name]}"
