"""关联仓库 LLM 画像（FR-PRE-02 增补，Spec 02 §9）。

链路：用户在 Bug 单申报仓库 -> 接入层可用性校验（repo_check，0 LLM）->
完整性评估通过后，本模块对**每个**关联仓库做一次 LLM 分析（只读摘要进
prompt），画像结果随 bug_repo.profile 持久化 -> 后续阶段（方案生成/自动
修复）读取画像渲染进各自 prompt，作为定位与修复的提示上下文。

成本口径：逐仓库一次调用、结果缓存（profile 非空即跳过）；重导/人工补充
仓库时 sync_bug_repos 先删后建行，新行 profile 为空自然触发重画像。
"""

from __future__ import annotations

import logging
from pathlib import Path

from autobugfixer.common.core.models import BugRepo, utcnow
from autobugfixer.common.prompts import load_prompt, prompt_version
from autobugfixer.common.security.injection import detect_injection, wrap_untrusted

logger = logging.getLogger(__name__)

# 只读摘要限制（token 限量，与评分代码实证同口径）
_SKIP_DIRS = {".git", ".baseline", "node_modules", "__pycache__", ".venv"}
_SKIP_SUFFIXES = {".png", ".jpg", ".gif", ".zip", ".gz", ".tar", ".db", ".bin", ".exe"}
_MAX_TREE_ENTRIES = 40  # 目录树最多列出的条目数（两层）
_MAX_STAT_FILES = 2_000  # 语言统计最多扫描的文件数
_MAX_README_CHARS = 800  # README 截取长度


def _iter_repo_files(root: Path):
    """遍历仓库文件（跳过噪声目录/二进制后缀，限量）。"""
    count = 0
    for path in sorted(root.rglob("*")):
        if count >= _MAX_STAT_FILES:
            return
        if (not path.is_file() or path.suffix.lower() in _SKIP_SUFFIXES
                or _SKIP_DIRS & set(path.parts)):
            continue
        count += 1
        yield path


def build_repo_digest(repo: BugRepo) -> str:
    """构建单仓库只读摘要（纯本地、不耗 LLM）：目录树 + 语言统计 + README 头部。

    摘要内容来自仓库文件（外部数据），统一 wrap_untrusted 包裹后再进 prompt。
    """
    root = Path(repo.path)
    lines = [f"路径: {repo.path}", f"分支: {repo.branch}",
             f"git 仓库: {'是' if repo.is_git else '否'}"]
    if root.is_dir():
        # 1) 两层目录树（根 + 各子目录一层，限量）
        tree: list[str] = []
        for child in sorted(root.iterdir()):
            if _SKIP_DIRS & {child.name} or child.name.startswith(".baseline"):
                continue
            tree.append(child.name + ("/…" if child.is_dir() else ""))
            if child.is_dir():
                for grand in sorted(child.iterdir())[:8]:
                    tree.append(f"  {child.name}/{grand.name}"
                                + ("/…" if grand.is_dir() else ""))
            if len(tree) >= _MAX_TREE_ENTRIES:
                tree.append("…（其余省略）")
                break
        if tree:
            lines.append("目录结构:\n" + "\n".join(tree))
        else:
            lines.append("目录结构: （空）")
        # 2) 语言/文件类型统计（扩展名计数 top 8）
        stats: dict[str, int] = {}
        for path in _iter_repo_files(root):
            key = path.suffix.lower() or "（无扩展名）"
            stats[key] = stats.get(key, 0) + 1
        top = sorted(stats.items(), key=lambda kv: -kv[1])[:8]
        if top:
            lines.append("文件类型统计: " + ", ".join(f"{k}x{v}" for k, v in top))
        # 3) README 头部（根目录，大小写不敏感）
        for candidate in sorted(root.glob("[Rr][Ee][Aa][Dd][Mm][Ee]*")):
            if candidate.is_file():
                try:
                    head = candidate.read_text(encoding="utf-8", errors="ignore")
                except OSError:
                    break
                lines.append("README 摘录:\n" + head[:_MAX_README_CHARS])
                break
    else:
        lines.append("（仓库目录当前不可读）")
    return wrap_untrusted("\n".join(lines))


def analyze_bug_repos(ctx, rows: list[BugRepo]) -> None:
    """逐仓库 LLM 画像（Spec 02 §9）：结果写 bug_repo.profile 供后续阶段注入。

    - 开关 repo_profile_enabled 关闭时跳过（下游回退基础仓库信息）；
    - 已画像（profile 非空）或不可用的仓库跳过，重析/唤醒不重复消耗；
    - LLM 失败沿网关重试后抛出 -> 阶段异常落 FAILED 断点续跑（口径同 B2）。
    """
    from autobugfixer.common.core.bugtext import build_bug_block
    from autobugfixer.features.completeness.schemas import RepoProfile

    pending = [r for r in rows if r.status == "available" and not r.profile]
    if not ctx.settings.repo_profile_enabled or not pending:
        return
    bug_block = build_bug_block(ctx)
    for repo in pending:
        digest = build_repo_digest(repo)
        report = detect_injection(digest)
        if report.flagged:  # 仓库内容含注入模式：留痕不阻断（口径同 bug_block）
            ctx.audit.log(action="injection_detected", target=f"repo:{repo.path}",
                          detail={"matched": report.matched_patterns}, task_id=ctx.task.id)
        prompt = load_prompt("repo_profile").format(
            bug_block=bug_block, repo_digest=digest)
        result = ctx.llm.analyze(prompt, RepoProfile,
                                 task_id=ctx.task.id, stage="repo_profile",
                                 session=ctx.session)
        assert isinstance(result, RepoProfile)
        repo.profile = result.model_dump()
        repo.profiled_at = utcnow()
        ctx.audit.log(action="llm_call", target=f"task:{ctx.task.id}",
                      detail={"stage": "repo_profile",
                              "prompt_version": prompt_version("repo_profile"),
                              "repo": repo.path},
                      task_id=ctx.task.id)
        logger.info("task=%s 仓库画像完成: %s", ctx.task.id, repo.path)
    ctx.session.flush()


def render_repo_profiles(rows: list[BugRepo]) -> str:
    """下游注入块（planning/fixing 共用）：逐仓库一行摘要，提示而非约束。

    无画像行（开关关闭/旧数据）回退基础信息（分支+路径+可用性），不阻断。
    """
    if not rows:
        return ""
    lines: list[str] = []
    for r in rows:
        base = f"- [{r.branch}] {r.path}（{'git' if r.is_git else '非 git'}，{r.status}）"
        p = r.profile or {}
        if not p:
            lines.append(base)
            continue
        parts = []
        if p.get("summary"):
            parts.append(p["summary"])
        if p.get("tech_stack"):
            parts.append("技术栈: " + "/".join(p["tech_stack"]))
        if p.get("key_dirs"):
            parts.append("关键目录: " + "/".join(p["key_dirs"]))
        if p.get("entry_points"):
            parts.append("入口: " + "/".join(p["entry_points"]))
        if p.get("bug_relevance"):
            parts.append("关联判断: " + p["bug_relevance"])
        lines.append(base + (": " + " | ".join(parts) if parts else ""))
    if len(rows) > 1:
        lines.append("（多仓库工作区按仓库名子目录布局，修复时请先确认目标仓库子目录）")
    return "\n".join(lines)
