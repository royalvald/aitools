"""Stage 公共辅助：Bug 文本块（注入防护）、修复工作区、diff 与禁改校验。

修复 agent 工具集（make_workspace_tools）已随 langchain 修复通道移除
（Spec 05 §6）：沙箱职责移交 codex workspace-write。
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

from ...security.injection import detect_injection, wrap_untrusted
from ..stage import TaskContext

logger = logging.getLogger(__name__)

BASELINE_DIR = ".baseline"  # 工作区内的基线快照（非 git 工作区替代 git diff）


def build_bug_block(ctx: TaskContext) -> str:
    """拼装 Bug 结构化文本并做注入防护（11.2 输入侧）：包裹边界 + 模式检测留痕。"""
    bug = ctx.bug
    text = (
        f"标题: {bug.title}\n描述: {bug.description}\n复现步骤: {bug.repro_steps}\n"
        f"期望结果: {bug.expected}\n实际结果: {bug.actual}\n环境版本: {bug.env_version}\n"
        f"影响模块: {','.join(bug.affected_modules) or '未标注'}"
    )
    report = detect_injection(text)
    if report.flagged:  # 不阻断，留痕告警
        ctx.audit.log(action="injection_detected", target=f"bug:{bug.platform_bug_id}",
                      detail={"matched": report.matched_patterns}, task_id=ctx.task.id)
    return wrap_untrusted(text)


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


def prepare_workspace(ctx: TaskContext) -> Path:
    """按 Bug 关联仓库创建独立工作区（Spec 01 §9.5）。

    - 前置条件：关联仓库 >=1 且全部可用（接入层已校验；修复前不复检，
      接入后目录被删等异常在此显式失败兜底，不再静默建空工作区）；
    - 单仓库：扁平布局（工作区根 = 仓库内容，向后兼容）；
    - 多仓库：``workspace/<仓库名>/`` 子目录布局（git 仓库逐个 worktree）；
    - 优先 git 受控分支（use_git_worktree 开启且仓库为 git 时：
      ``git worktree add`` + ``autofix/<bug-id>`` 分支）；
      非 git 或 git 不可用时回退目录快照方案。
    """
    from ...models import BugRepo

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
            shutil.copy2(item, target)


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
        old = old_path.read_text(encoding="utf-8").splitlines(keepends=True) if old_path.exists() else []
        new = new_path.read_text(encoding="utf-8").splitlines(keepends=True)
        if old != new:
            changed.append(str(rel).replace("\\", "/"))
            diffs.append("".join(difflib.unified_diff(
                old, new, fromfile=f"a/{rel}", tofile=f"b/{rel}")))
    return changed, "".join(diffs)


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


def resolve_executor(ctx: TaskContext):
    """按任务关联的 Environment 行解析执行器（11.1 适配器注册）。

    ssh/docker 类型走 registry 构建（凭据由 Vault 解密注入）；
    local 等仿真类型沿用注入的默认执行器，保持现有行为。
    """
    from ...adapters.registry import get_env_executor_for
    from ...models import Environment
    from ...security.credentials import CredentialVault

    if ctx.task.environment_id:
        env = ctx.session.get(Environment, ctx.task.environment_id)
        if env is not None and env.type in ("ssh", "docker"):
            return get_env_executor_for(
                env, vault=CredentialVault(ctx.settings.fernet_key))
    return ctx.executor
