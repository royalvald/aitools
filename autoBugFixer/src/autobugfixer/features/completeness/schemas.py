"""完整性分析结构化输出 Schema（FR-PRE-02）。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class CompletenessEval(BaseModel):
    """完整性评估结论（FR-PRE-02）。"""

    complete: bool
    missing: list[str] = Field(default_factory=list)  # 缺失项清单
    suggestions: list[str] = Field(default_factory=list)  # 建议补充内容


class RepoProfile(BaseModel):
    """单仓库画像结论（FR-PRE-02 增补，Spec 02 §9）：随 bug_repo.profile 持久化。"""

    summary: str  # 仓库用途一句话
    tech_stack: list[str] = Field(default_factory=list)  # 语言/框架
    key_dirs: list[str] = Field(default_factory=list)  # 关键目录
    entry_points: list[str] = Field(default_factory=list)  # 入口文件/模块
    bug_relevance: str = ""  # 与本 Bug 的关联判断（提示性，不裁剪仓库）
