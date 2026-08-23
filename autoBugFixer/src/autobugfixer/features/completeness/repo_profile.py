"""全局仓库 LLM 画像 + Bug 仓库匹配（Spec 02 §9 v2 / Spec 01 §10）。

链路（仓库信息是全局共享资产，不是单个 Bug 的附庸）：
- 登记表 repo（独立登记/声明自动登记）-> 本模块 ``profile_repo`` 对未画像
  仓库做一次 **无 Bug 上下文** 的事实画像（用途/技术栈/关键目录/入口），
  结果挂全局行、所有 Bug 复用（``ensure_profiles`` 补齐，手动刷新）；
- 完整性通过后 ``match_bug_repos``：一次 LLM 调用分析 Bug 信息 x 候选
  仓库画像库 -> 逐仓库相关性判定 + 从登记表补选未声明的相关仓库，
  相关性写 bug_repo.relevance（Bug 维度），补选建 origin=matched 链接；
- ``render_repo_profiles``：下游（方案生成/自动修复）注入块 = 全局画像
  + 本 Bug 相关性，提示而非约束。

成本口径：画像每仓库全局一次（profile 非空即跳过）；匹配每 Bug 一次，
无增益时（单一声明仓库且登记表无其他可用候选）跳过不耗调用。
"""

from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from autobugfixer.common.core.models import BugRepo, Repo, utcnow
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
    由 repo_match 产生）；LLM 失败沿网关重试后抛出 -> 调用方决定 FAILED/告警。
    """
    from autobugfixer.features.completeness.schemas import RepoProfile

    digest = build_repo_digest(repo)
    report = detect_injection(digest)
    if report.flagged and audit is not None:  # 仓库内容含注入模式：留痕不阻断
        audit.log(action="injection_detected", target=f"repo:{repo.path}",
                  detail={"matched": report.matched_patterns}, task_id=task_id)
    prompt = load_prompt("repo_profile").format(repo_digest=digest)
    result = llm.analyze(prompt, RepoProfile,
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


# ---------- Bug x 仓库库匹配（每 Bug 一次） ----------

def _candidate_block(candidates: list[Repo]) -> str:
    """候选仓库清单（画像摘要行，repo_id 供输出引用）。"""
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
    return "\n".join(lines)


def _match_needed(links: list[BugRepo], extras: list[Repo]) -> bool:
    """匹配调用触发启发式：只在有信息增益时耗这一次调用。

    - 登记表有额外可用候选（可能补选未声明仓库）-> 需要；
    - 多仓库链接（需区分主次/相关性）-> 需要；
    - 单一声明仓库且无额外候选 -> 相关性平凡（用户指定），跳过；
    - 无变化重跑（链接已带相关性且无新候选）-> 跳过，不重复消耗。
    """
    if extras:
        return True
    if len(links) <= 1:
        return False
    return not all(l.relevance for l in links)


def match_bug_repos(ctx) -> list[BugRepo]:
    """Bug x 登记表匹配（Spec 02 §9 v2）：一次 LLM 调用 -> 相关性 + 补选。

    - 声明链接（origin=declared）强制保留（信任用户指定）；
    - LLM matches 按 repo_id 解析：声明的补相关性，未声明的建 matched 链接
      （追加在声明之后）；无法解析的 id 忽略并留痕；
    - 失败沿网关重试后抛出 -> 阶段异常落 FAILED（口径同其他 analyze）。
    """
    from autobugfixer.common.core.bugtext import build_bug_block
    from autobugfixer.features.completeness.schemas import RepoMatch
    from autobugfixer.features.ingest.repo_check import load_bug_repos

    links = load_bug_repos(ctx.session, ctx.bug.id)
    if not ctx.settings.repo_profile_enabled:
        return links
    linked_ids = {l.repo_id for l in links}
    extras = list(ctx.session.scalars(select(Repo).where(
        Repo.status == "available", Repo.id.not_in(linked_ids)
    ).order_by(Repo.id).limit(ctx.settings.repo_match_max_candidates)).all())
    if not links and not extras:
        return links  # 无候选空间（门禁已保证登记表非空，此处兜底）
    if not _match_needed(links, extras):
        return links

    candidates = [l.repo for l in links] + extras
    ensure_profiles(ctx, candidates)  # 候选先补齐画像（全局缓存，已画像零成本）
    prompt = load_prompt("repo_match").format(
        bug_block=build_bug_block(ctx),
        repo_library=_candidate_block(candidates))
    result = ctx.llm.analyze(prompt, RepoMatch,
                             task_id=ctx.task.id, stage="repo_match",
                             session=ctx.session)
    assert isinstance(result, RepoMatch)
    candidate_ids = {r.id for r in candidates}
    judgments: dict[int, str] = {}
    for m in result.matches:
        if m.repo_id in candidate_ids:
            judgments[m.repo_id] = m.relevance[:500]
        else:
            ctx.audit.log(action="repo_match_ignored", target=f"task:{ctx.task.id}",
                          detail={"repo_id": m.repo_id,
                                  "reason": "候选集外 id"},
                          task_id=ctx.task.id)
    ctx.audit.log(action="llm_call", target=f"task:{ctx.task.id}",
                  detail={"stage": "repo_match",
                          "prompt_version": prompt_version("repo_match"),
                          "candidates": len(candidates),
                          "judged": len(judgments)}, task_id=ctx.task.id)

    # 声明链接：保留 + 补相关性（未被判定的标注用户声明）
    now = utcnow()
    for link in links:
        if link.origin == "declared":
            link.relevance = judgments.get(link.repo_id) or "（用户声明修复仓库）"
            link.matched_at = now
    # 补选链接：重建（先删旧 matched，再按判定顺序追加）
    session = ctx.session
    from sqlalchemy import delete
    session.execute(delete(BugRepo).where(
        BugRepo.bug_ticket_id == ctx.bug.id, BugRepo.origin == "matched"))
    declared_ids = {l.repo_id for l in links if l.origin == "declared"}
    seq_base = len(declared_ids)
    added = 0
    for rid, relevance in judgments.items():
        if rid in declared_ids:
            continue
        session.add(BugRepo(bug_ticket_id=ctx.bug.id, repo_id=rid,
                            seq=seq_base + added, origin="matched",
                            relevance=relevance, matched_at=now))
        added += 1
    session.flush()
    ctx.audit.log(action="repo_match", target=f"task:{ctx.task.id}",
                  detail={"declared": len(declared_ids), "matched_added": added,
                          "extras_candidates": len(extras)},
                  task_id=ctx.task.id)
    return load_bug_repos(ctx.session, ctx.bug.id)


# ---------- 下游注入（方案生成 / 自动修复共用） ----------

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
    if len(rows) > 1:
        lines.append("（多仓库工作区按仓库名子目录布局，修复时请先确认目标仓库子目录）")
    return "\n".join(lines)
