"""全局仓库 LLM 画像 + 候选库渲染（Spec 02 §9 v3 / Spec 01 §10）。

链路（仓库信息是全局共享资产，不是单个 Bug 的附庸）：
- 登记表 repo（独立登记/声明自动登记）-> 本模块 ``profile_repo`` 对未画像
  仓库做一次 **无 Bug 上下文** 的事实画像（用途/技术栈/关键目录/入口），
  结果挂全局行、所有 Bug 复用（``ensure_profiles`` 补齐，手动刷新）；
- planning 注入 ``candidate_library_block``（声明链接仓库 + 登记表其他
  可用候选，限量）：LLM 在方案输出中自行评估 Bug x 仓库对应关系
  （``target_repos``），由 planning 阶段写回 bug_repo（Spec 02 §9 v3）；
- ``render_repo_profiles``：下游（自动修复）注入块 = 全局画像
  + 本 Bug 相关性，提示而非约束。

成本口径：画像每仓库全局一次（profile 非空即跳过）；对应关系判定并入
planning 调用，无独立匹配开销。
"""

from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from autobugfixer.common.core.models import Repo, utcnow
from autobugfixer.common.prompts import prompt_version, render_prompt
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


def build_repo_digest(repo: Repo) -> str:
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


# ---------- 全局画像（仓库固有事实，无 Bug 上下文） ----------

def profile_repo(llm, session: Session, repo: Repo, *,
                 task_id: int | None = None, audit=None) -> None:
    """单仓库 LLM 事实画像（Spec 02 §9 v2）：结果写全局 repo.profile。

    画像只描述仓库固有事实（不含任何 Bug 判断——相关性属 Bug 维度，
    由 planning 的 target_repos 产生）；LLM 失败沿网关重试后抛出 ->
    调用方决定 FAILED/告警。
    """
    from autobugfixer.features.completeness.schemas import RepoProfile

    digest = build_repo_digest(repo)
    report = detect_injection(digest)
    if report.flagged and audit is not None:  # 仓库内容含注入模式：留痕不阻断
        audit.log(action="injection_detected", target=f"repo:{repo.path}",
                  detail={"matched": report.matched_patterns}, task_id=task_id)
    system, user = render_prompt("repo_profile", repo_digest=digest)
    result = llm.analyze(user, RepoProfile, system=system,
                         task_id=task_id, stage="repo_profile", session=session)
    assert isinstance(result, RepoProfile)
    repo.profile = result.model_dump()
    repo.profiled_at = utcnow()
    if audit is not None:
        audit.log(action="llm_call", target=f"repo:{repo.id}",
                  detail={"stage": "repo_profile",
                          "prompt_version": prompt_version("repo_profile"),
                          "repo": repo.path, "task_id": task_id},
                  task_id=task_id)
    logger.info("仓库画像完成: %s@%s（全局复用）", repo.path, repo.branch)


def ensure_profiles(ctx, repos: list[Repo]) -> None:
    """补齐未画像仓库（完整性通过后调用）：可用 + profile 为空才画像。

    - 开关 repo_profile_enabled 关闭时跳过（下游回退基础仓库信息）；
    - 已画像（全局缓存）或不可用的仓库跳过——同一仓库第二个 Bug 起零成本；
    - LLM 失败沿网关重试后抛出 -> 阶段异常落 FAILED 断点续跑（口径同 B2）。
    """
    pending = [r for r in repos if r.status == "available" and not r.profile]
    if not ctx.settings.repo_profile_enabled or not pending:
        return
    for repo in pending:
        profile_repo(ctx.llm, ctx.session, repo,
                     task_id=ctx.task.id, audit=ctx.audit)
    ctx.session.flush()


def refresh_profile(llm, session: Session, repo: Repo, *,
                    audit=None) -> None:
    """手动刷新画像（CLI/API 登记表维护入口）：清空后重画。"""
    repo.profile = {}
    profile_repo(llm, session, repo, audit=audit)
    session.flush()


# ---------- 候选库渲染（planning 注入，供 target_repos 判定） ----------

def candidate_library_block(candidates: list[Repo]) -> str:
    """候选仓库登记表渲染（Spec 02 §9 v3）：画像摘要行 + repo_id 供输出引用。

    条目内容含 LLM 画像产物（二阶外部数据，11.2 输入侧）：统一 wrap_untrusted
    包裹；无画像回退基础行（路径/分支），不阻断。
    """
    lines = []
    for repo in candidates:
        p = repo.profile or {}
        facts = []
        if p.get("summary"):
            facts.append(p["summary"])
        if p.get("tech_stack"):
            facts.append("技术栈: " + "/".join(p["tech_stack"]))
        if p.get("key_dirs"):
            facts.append("关键目录: " + "/".join(p["key_dirs"]))
        if p.get("entry_points"):
            facts.append("入口: " + "/".join(p["entry_points"]))
        lines.append(f"- [repo_id={repo.id}] {repo.path}（分支 {repo.branch}）: "
                     + (" | ".join(facts) if facts else "（未画像）"))
    return wrap_untrusted("\n".join(lines))


def load_repo_candidates(ctx) -> list[Repo]:
    """组装 planning 候选集：声明链接仓库 + 登记表其他可用仓库（限量）。

    开关 repo_profile_enabled 关闭时仅返回声明链接仓库（不注入候选库、
    不做补选，下游回退基础仓库信息）。
    """
    from autobugfixer.features.ingest.repo_check import load_bug_repos

    linked = [l.repo for l in load_bug_repos(ctx.session, ctx.bug.id)]
    if not ctx.settings.repo_profile_enabled:
        return linked
    linked_ids = {r.id for r in linked}
    extras = list(ctx.session.scalars(select(Repo).where(
        Repo.status == "available", Repo.id.not_in(linked_ids)
    ).order_by(Repo.id).limit(ctx.settings.repo_candidate_limit)).all())
    return linked + extras


# ---------- 下游注入（自动修复） ----------

def render_repo_profiles(session: Session, bug_id: int) -> str:
    """下游注入块：全局画像 + 本 Bug 相关性，提示而非约束。

    无画像行（开关关闭/旧数据）回退基础信息（分支+路径+可用性），不阻断。
    """
    from autobugfixer.features.ingest.repo_check import load_bug_repos

    rows = load_bug_repos(session, bug_id)
    if not rows:
        return ""
    lines: list[str] = []
    for r in rows:
        repo = r.repo
        base = f"- [{repo.branch}] {repo.path}（{'git' if repo.is_git else '非 git'}，{repo.status}）"
        p = repo.profile or {}
        if not p:
            lines.append(base + (f"：{r.relevance}" if r.relevance else ""))
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
        if r.relevance:
            parts.append("关联判断: " + r.relevance)
        lines.append(base + (": " + " | ".join(parts) if parts else ""))
    # 画像/相关性为 LLM 产物（二阶外部数据，11.2 输入侧）：条目包裹边界；
    # 多仓库布局说明是系统指令，保持在边界外
    note = ("\n（多仓库工作区按仓库名子目录布局，修复时请先确认目标仓库子目录）"
            if len(rows) > 1 else "")
    return wrap_untrusted("\n".join(lines)) + note
