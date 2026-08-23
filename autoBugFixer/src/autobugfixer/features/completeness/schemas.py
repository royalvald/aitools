"""完整性分析结构化输出 Schema（FR-PRE-02）。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class CompletenessEval(BaseModel):
    """完整性评估结论（FR-PRE-02）。"""

    complete: bool
    missing: list[str] = Field(default_factory=list)  # 缺失项清单
    suggestions: list[str] = Field(default_factory=list)  # 建议补充内容


class RepoProfile(BaseModel):
    """全局仓库画像结论（Spec 02 §9 v2）：仓库固有事实，挂 repo.profile 全局复用。

    不含 Bug 相关性——相关性是 Bug 维度判断，由 RepoMatch 产生。
    """

    summary: str  # 仓库用途一句话
    tech_stack: list[str] = Field(default_factory=list)  # 语言/框架
    key_dirs: list[str] = Field(default_factory=list)  # 关键目录
    entry_points: list[str] = Field(default_factory=list)  # 入口文件/模块


class RepoMatchItem(BaseModel):
    """单仓库与当前 Bug 的匹配结论。"""

    repo_id: int  # 候选清单中的仓库 id
    relevance: str = ""  # 与本 Bug 的关联判断（提示性，不裁剪）


class RepoMatch(BaseModel):
    """Bug x 登记表匹配结论（Spec 02 §9 v2）：相关性判定 + 补选。"""

    matches: list[RepoMatchItem] = Field(default_factory=list)
    note: str = ""
