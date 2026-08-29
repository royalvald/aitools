"""全局仓库登记 + 修复关联解析（Spec 01 §9/§10）。

仓库是独立于 Bug 的共享资产（Spec 01 §10）：
- 登记表 repo：path+branch 唯一；登记时本地可用性校验（0 LLM），
  LLM 画像一次生成全局复用（画像逻辑在 completeness/repo_profile）；
- Bug 声明（repo_url/repo_branch 按 `;` 切分、按位对应分支）解析到登记表
  条目并重建 bug_repo 关联（先删后建，保持声明顺序）；
- 未登记声明：repo_auto_register 开启时自动登记（画像延后到首次引用），
  关闭时跳过留痕——由完整性门禁拦下提示先登记；
- 登记入口：CLI/API 手动登记 + Bug 声明自动登记，全平台适配器共用。
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from autobugfixer.adapters.platform import BugTicketData
from autobugfixer.common.core.models import BugRepo, BugTicket, Repo, utcnow


def split_repos(repo_url: str | None, repo_branch: str | None) -> list[tuple[str, str]]:
    """切分仓库/分支单元格（Spec 01 §9.2 B9-1/B9-2/B9-3）。

    单路径 -> 1 项；多路径 `;` 分隔按位对应分支（不足补 main）；空值 -> 空列表。
    """
    paths = [p.strip() for p in (repo_url or "").split(";") if p.strip()]
    branches = [b.strip() for b in (repo_branch or "").split(";") if b.strip()]
    return [(p, branches[i] if i < len(branches) else "main")
            for i, p in enumerate(paths)]


def _is_remote(path: str) -> bool:
    """远程地址识别（§9.3 B9-5c：http(s)://、git@、ssh:// 等本期不支持）。"""
    return "://" in path or path.startswith("git@")


def _verify_git_branch(repo: Path, branch: str) -> bool:
    """git rev-parse --verify 验目标分支存在（§9.3 B9-5a）。"""
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "--verify", branch],
            capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0


@dataclass
class RepoStatus:
    """单仓库可用性结论。"""

    is_git: bool
    ok: bool
    reason: str = ""


def check_repo(path: str, branch: str) -> RepoStatus:
    """逐仓库可用性校验（纯本地，不耗 LLM）。"""
    if _is_remote(path):
        return RepoStatus(is_git=False, ok=False, reason="远程地址本期不支持（仅本地目录路径）")
    p = Path(path)
    if not p.exists():
        return RepoStatus(is_git=False, ok=False, reason="路径不存在")
    if not p.is_dir():
        return RepoStatus(is_git=False, ok=False, reason="非目录（指向文件）")
    is_git = (p / ".git").exists()
    if is_git:
        if _verify_git_branch(p, branch):
            return RepoStatus(is_git=True, ok=True)
        return RepoStatus(is_git=True, ok=False, reason=f"分支缺失: {branch}")
    if any(p.iterdir()):
        return RepoStatus(is_git=False, ok=True)
    return RepoStatus(is_git=False, ok=False, reason="空目录")


# ---------- 登记表操作（Spec 01 §10） ----------

def get_repo(session: Session, path: str, branch: str = "main") -> Repo | None:
    """按唯一键 (path, branch) 查登记表条目。"""
    return session.scalar(select(Repo).where(Repo.path == path, Repo.branch == branch))


def register_repo(session: Session, path: str, branch: str = "main", *,
                  source: str = "manual", recheck: bool = True) -> Repo:
    """登记/复检仓库（get-or-create + 本地可用性校验，0 LLM）。

    已登记条目复检并刷新校验结论（checked_at/status/fail_reason），
    画像字段不动（一次画像长期复用，手动刷新走 profile_repo）。
    """
    repo = get_repo(session, path, branch)
    created = repo is None
    if created:
        repo = Repo(path=path, branch=branch, source=source)
        session.add(repo)
    elif source == "manual":
        repo.source = source  # 自动登记后被手动登记确认
    if recheck or created:
        status = check_repo(path, branch)
        repo.is_git = status.is_git
        repo.status = "available" if status.ok else "unavailable"
        repo.fail_reason = status.reason
        repo.checked_at = utcnow()
    session.flush()
    return repo


def list_repos(session: Session, *, available_only: bool = False) -> list[Repo]:
    """登记表列表（按登记先后）。"""
    stmt = select(Repo).order_by(Repo.id)
    if available_only:
        stmt = stmt.where(Repo.status == "available")
    return list(session.scalars(stmt).all())


def has_available_repo(session: Session) -> bool:
    """登记表是否存在可用仓库（未声明 Bug 的门禁条件）。"""
    return session.scalar(select(Repo.id).where(Repo.status == "available").limit(1)) is not None


# ---------- Bug 声明 -> 登记表解析 + 关联重建 ----------

def sync_bug_repos(session: Session, bug: BugTicket, data: BugTicketData, *,
                   auto_register: bool | None = None) -> list[BugRepo]:
    """按接入数据把声明解析到全局登记表并重建 bug_repo 关联（先删后建）。

    - 已登记：直接链接（登记表结论复用，不重复校验）；
    - 未登记 + auto_register（默认取配置 repo_auto_register）：自动登记
      （即时校验一次，画像延后到首次被引用时补齐）；
    - 未登记 + 不自动登记：跳过该声明（完整性门禁会拦下并提示先登记）。
    """
    if auto_register is None:
        from autobugfixer.common.core.config import get_settings
        auto_register = get_settings().repo_auto_register
    session.execute(delete(BugRepo).where(BugRepo.bug_ticket_id == bug.id))
    linked: dict[int, BugRepo] = {}
    rows: list[BugRepo] = []
    for seq, (path, branch) in enumerate(split_repos(data.repo_url, data.repo_branch)):
        repo = get_repo(session, path, branch)
        if repo is None:
            if not auto_register:
                continue
            repo = register_repo(session, path, branch, source="auto")
        if repo.id in linked:  # 同一仓库重复声明：保序去重
            continue
        row = BugRepo(bug_ticket_id=bug.id, repo_id=repo.id, seq=seq, origin="declared")
        session.add(row)
        linked[repo.id] = row
        rows.append(row)
    session.flush()
    return rows


def load_bug_repos(session: Session, bug_id: int) -> list[BugRepo]:
    """按给定顺序取 Bug 关联仓库链接（含 repo joined，仓库名单见 .repo）。"""
    return list(session.scalars(select(BugRepo).where(
        BugRepo.bug_ticket_id == bug_id).order_by(BugRepo.seq)).all())


def unresolved_declarations(session: Session, bug: BugTicket) -> list[dict]:
    """声明了但未链接到登记表的仓库（auto_register 关闭时的门禁输入）。"""
    linked = {(l.repo.path, l.repo.branch) for l in load_bug_repos(session, bug.id)}
    return [{"path": p, "branch": b, "status": "unavailable",
             "reason": "未在登记表中（请先登记该仓库）"}
            for p, b in split_repos(bug.repo_url, bug.repo_branch)
            if (p, b) not in linked]


def repo_check_summary(rows: list[BugRepo]) -> list[dict]:
    """repo_check 审计摘要（随 task_ingest 携带，读登记表事实）。"""
    return [{"path": r.repo.path, "branch": r.repo.branch,
             "status": r.repo.status, "reason": r.repo.fail_reason}
            for r in rows]


def repos_ready(rows: list[BugRepo]) -> bool:
    """放行条件（§9.1 要求 3）：>=1 个关联仓库且登记表结论全部可用。"""
    return bool(rows) and all(r.repo.status == "available" for r in rows)
