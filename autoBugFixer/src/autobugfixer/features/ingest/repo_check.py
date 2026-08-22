"""修复关联仓库校验（Spec 01 §9，P1）。

- 切分约定（§9.2）：仓库地址与分支均按 `;` 切分（strip、去空项），分支按位
  对应各仓库，不足位补 main，整列空 = 全部 main；
- 可用性校验（§9.3）：纯本地检查、不耗 LLM——路径存在且为目录；git 仓库
  验目标分支存在（rev-parse --verify）；非 git 目录非空即可用；远程 URL
  本期不支持；
- 持久化：校验结果逐仓库写 bug_repo 表（接入时执行一次，平台重导时复检）。

全部平台适配器（CSV/Jira/禅道/webhook）共用本逻辑：仓库字段经 BugTicketData
的 repo_url/repo_branch 单字符串携带，在此统一切分。
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from autobugfixer.adapters.platform import BugTicketData
from autobugfixer.common.core.models import BugRepo, BugTicket


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


def sync_bug_repos(session: Session, bug: BugTicket, data: BugTicketData) -> list[BugRepo]:
    """按接入数据重建 bug_repo 行（先删后建，保持给定顺序；接入/重导复检共用）。"""
    session.execute(delete(BugRepo).where(BugRepo.bug_ticket_id == bug.id))
    now = datetime.now(timezone.utc)
    rows: list[BugRepo] = []
    for seq, (path, branch) in enumerate(split_repos(data.repo_url, data.repo_branch)):
        status = check_repo(path, branch)
        row = BugRepo(
            bug_ticket_id=bug.id, seq=seq, path=path, branch=branch,
            is_git=status.is_git,
            status="available" if status.ok else "unavailable",
            fail_reason=status.reason, checked_at=now,
        )
        session.add(row)
        rows.append(row)
    session.flush()
    return rows


def load_bug_repos(session: Session, bug_id: int) -> list[BugRepo]:
    """按给定顺序取 Bug 关联仓库行。"""
    return list(session.scalars(select(BugRepo).where(
        BugRepo.bug_ticket_id == bug_id).order_by(BugRepo.seq)).all())


def repo_check_summary(rows: list[BugRepo]) -> list[dict]:
    """repo_check 审计摘要（随 task_ingest 携带）。"""
    return [{"path": r.path, "branch": r.branch, "status": r.status,
             "reason": r.fail_reason} for r in rows]


def repos_ready(rows: list[BugRepo]) -> bool:
    """放行条件（§9.1 要求 3）：>=1 个关联仓库且全部可用。"""
    return bool(rows) and all(r.status == "available" for r in rows)
