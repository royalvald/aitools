"""修复工作区管理（Spec 01 §9.5 + Spec 05）：git worktree / 目录快照与 diff 产出。

修复 agent 沙箱职责由 codex workspace-write 承担（Spec 05 §6），
本模块只负责工作区落位、基线快照与出口 diff 计算。
"""

from __future__ import annotations

import difflib
import fnmatch
import hashlib
import logging
import shutil
import subprocess
from pathlib import Path

from sqlalchemy import select

logger = logging.getLogger(__name__)

BASELINE_DIR = ".baseline"  # 工作区内的基线快照（非 git 工作区替代 git diff）


def _run_git(args: list[str], cwd: str | Path | None = None) -> subprocess.CompletedProcess:
    """git 子进程：参数列表形式调用（不经 shell），失败抛异常由调用方回退。"""
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True,
                          text=True, timeout=60, check=True)


def _is_git_repo(path: Path) -> bool:
    try:
        proc = _run_git(["-C", str(path), "rev-parse", "--is-inside-work-tree"])
        return proc.stdout.strip() == "true"
    except Exception:
        return False


def prepare_workspace(ctx) -> Path:
    """按 Bug 关联仓库创建独立工作区（Spec 01 §9.5）。

    - 前置条件：关联仓库 >=1 且全部可用（接入层已校验；修复前不复检，
      接入后目录被删等异常在此显式失败兜底，不再静默建空工作区）；
    - 单仓库：扁平布局（工作区根 = 仓库内容，向后兼容）；
    - 多仓库：``workspace/<仓库名>/`` 子目录布局（git 仓库逐个 worktree）；
    - 优先 git 受控分支（use_git_worktree 开启且仓库为 git 时：
      ``git worktree add`` + ``autofix/<bug-id>`` 分支）；
      非 git 或 git 不可用时回退目录快照方案。
    """
    from autobugfixer.common.core.models import BugRepo

    repos = list(ctx.session.scalars(select(BugRepo).where(
        BugRepo.bug_ticket_id == ctx.bug.id).order_by(BugRepo.seq)).all())
    unavailable = [r for r in repos if r.status != "available"]
    if not repos:
        raise RuntimeError(
            "任务缺少关联仓库（Spec 01 §9：接入层应已拦截，请检查 bug_repo 数据）")
    if unavailable:
        raise RuntimeError("关联仓库不可用: "
                           + "; ".join(f"{r.path}({r.fail_reason})" for r in unavailable))

    workspace = Path(ctx.settings.workspace_root) / f"task-{ctx.task.id}"
    if workspace.exists():
        shutil.rmtree(workspace)
    branch = f"autofix/{ctx.bug.platform_bug_id}"

    single = len(repos) == 1
    for repo in repos:
        src = Path(repo.path)
        if not src.is_dir():  # 接入后被删除：显式失败兜底
            raise RuntimeError(f"关联仓库目录不存在: {repo.path}")
        target = workspace if single else workspace / _repo_dir_name(repo.path)
        _prepare_repo_workspace(src, target, branch, repo.branch,
                                use_git_worktree=ctx.settings.use_git_worktree)

    if single and (workspace / ".git").exists():
        return workspace  # git 工作区用 git diff，无需 baseline 快照
    # 基线快照供 diff 比对（覆盖单仓库扁平与多仓库子目录两种布局）
    baseline = workspace / BASELINE_DIR
    baseline.mkdir(parents=True, exist_ok=True)
    for item in workspace.iterdir():
        if item.name == BASELINE_DIR:
            continue
        if item.is_dir():
            shutil.copytree(item, baseline / item.name)
        else:
            shutil.copy2(item, baseline)
    return workspace


def _repo_dir_name(path: str) -> str:
    """多仓库子目录名：取仓库路径末段（重名时由先到后覆盖，接入数据应避免）。"""
    name = Path(path).name or Path(path).anchor.replace(":", "").replace("\\", "")
    return name or "repo"


def _prepare_repo_workspace(src: Path, target: Path, branch: str, repo_branch: str,
                            *, use_git_worktree: bool = False) -> None:
    """单个关联仓库的工作区落位：开关开启且为 git 仓库时用 worktree，
    失败/非 git/开关关回退目录快照。"""
    if use_git_worktree and _is_git_repo(src):
        try:
            # 重试场景：清理同名 worktree 与分支残留（best-effort）
            subprocess.run(["git", "-C", str(src), "worktree", "remove", "--force",
                            str(target)], capture_output=True, timeout=60)
            subprocess.run(["git", "-C", str(src), "branch", "-D", branch],
                           capture_output=True, timeout=60)
            _run_git(["-C", str(src), "worktree", "add", str(target),
                      "-b", branch, repo_branch or "HEAD"])
            return  # git 工作区用 git diff
        except Exception as exc:
            logger.warning("git worktree 创建失败，回退目录快照: %s", exc)
            if target.exists():
                shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.name == ".git":
            continue  # 快照方案不复制 git 元数据
        if item.is_dir():
            shutil.copytree(item, target / item.name)
        else:
            shutil.copy2(item, target / item.name)


def _git_diff(workspace: Path) -> tuple[list[str], str]:
    """git 工作区差异：暂存后取 --cached diff（含新增文件全文）。"""
    try:
        _run_git(["add", "-A"], cwd=workspace)
        names = _run_git(["diff", "--cached", "--name-only", "HEAD"], cwd=workspace)
        diff = _run_git(["diff", "--cached", "HEAD"], cwd=workspace)
        changed = [line.strip() for line in names.stdout.splitlines() if line.strip()]
        return changed, diff.stdout
    except Exception as exc:
        logger.warning("git diff 失败: %s", exc)
        return [], ""


def compute_diff(workspace: Path) -> tuple[list[str], str]:
    """比对基线与工作区当前内容，产出变更文件清单与 unified diff。"""
    if (workspace / ".git").exists():  # git worktree（.git 为文件）或 git 仓库
        changed, diff = _git_diff(workspace)
        if changed or diff:
            return changed, diff
    baseline = workspace / BASELINE_DIR
    changed: list[str] = []
    diffs: list[str] = []
    current_files = {
        p.relative_to(workspace) for p in workspace.rglob("*") if p.is_file()
        and BASELINE_DIR not in p.relative_to(workspace).parts
        and ".git" not in p.relative_to(workspace).parts
    }
    for rel in sorted(current_files):
        old_path = baseline / rel
        new_path = workspace / rel
        new_bytes = new_path.read_bytes()
        old_bytes = old_path.read_bytes() if old_path.exists() else b""
        if old_bytes == new_bytes:
            continue
        rel_name = str(rel).replace("\\", "/")
        changed.append(rel_name)
        diffs.append(_diff_one(rel_name, old_bytes, new_bytes))
    return changed, "".join(diffs)


def _diff_one(rel: str, old_bytes: bytes, new_bytes: bytes) -> str:
    """单文件 unified diff：文本按行对比；二进制按字节比对并以哈希摘要表达。

    修复：真实仓库常含二进制文件（图片/依赖包/数据库等），此前 read_text(utf-8)
    硬解首遇非 UTF-8 字节即 UnicodeDecodeError -> 修复阶段异常落 FAILED。
    """
    try:
        old = old_bytes.decode("utf-8").splitlines(keepends=True)
        new = new_bytes.decode("utf-8").splitlines(keepends=True)
        return "".join(difflib.unified_diff(old, new, fromfile=f"a/{rel}", tofile=f"b/{rel}"))
    except UnicodeDecodeError:
        old_digest = hashlib.sha256(old_bytes).hexdigest()[:16]
        new_digest = hashlib.sha256(new_bytes).hexdigest()[:16]
        status = "new" if not old_bytes else "modified"
        return (f"diff --git a/{rel} b/{rel}\n"
                f"Binary file {status}: sha256 {old_digest or '-'} -> {new_digest}\n")


def check_forbidden(changed_files: list[str], forbidden: list[str]) -> list[str]:
    """出口侧静态校验（11.2）：变更文件不得触碰禁改路径清单。"""
    violations = []
    for f in changed_files:
        for pattern in forbidden:
            if fnmatch.fnmatch(f, pattern) or fnmatch.fnmatch(Path(f).name, pattern):
                violations.append(f)
                break
    return violations


def diff_hash(diff: str) -> str:
    """计算 diff 文本的短哈希（sha256 前 16 位），用于变更指纹去重。"""
    return hashlib.sha256(diff.encode()).hexdigest()[:16]
