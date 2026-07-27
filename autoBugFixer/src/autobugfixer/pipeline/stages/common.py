"""Stage 公共辅助：Bug 文本块（注入防护）、修复工作区与 agent 工具、diff 与禁改校验。"""

from __future__ import annotations

import difflib
import fnmatch
import hashlib
import logging
import shutil
import subprocess
from pathlib import Path

from langchain_core.tools import tool

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
    """按 Bug 关联仓库创建独立工作区。

    优先 git 受控分支（use_git_worktree 开启且仓库为 git 时：`git worktree add`
    + `autofix/<bug-id>` 分支）；仓库非 git 或 git 不可用时回退目录快照方案。
    """
    workspace = Path(ctx.settings.workspace_root) / f"task-{ctx.task.id}"
    if workspace.exists():
        shutil.rmtree(workspace)
    branch = f"autofix/{ctx.bug.platform_bug_id}"
    src = Path(ctx.bug.repo_url) if ctx.bug.repo_url and Path(ctx.bug.repo_url).is_dir() else None

    if ctx.settings.use_git_worktree and src is not None and _is_git_repo(src):
        try:
            # 重试场景：清理同名 worktree 与分支残留（best-effort）
            subprocess.run(["git", "-C", str(src), "worktree", "remove", "--force",
                            str(workspace)], capture_output=True, timeout=60)
            subprocess.run(["git", "-C", str(src), "branch", "-D", branch],
                           capture_output=True, timeout=60)
            if workspace.exists():
                shutil.rmtree(workspace)
            _run_git(["-C", str(src), "worktree", "add", str(workspace),
                      "-b", branch, ctx.bug.repo_branch or "HEAD"])
            return workspace  # git 工作区用 git diff，无需 baseline 快照
        except Exception as exc:
            logger.warning("git worktree 创建失败，回退目录快照: %s", exc)
            if workspace.exists():
                shutil.rmtree(workspace)

    workspace.mkdir(parents=True)
    if src is not None:
        for item in src.iterdir():
            if item.name == ".git":
                continue  # 快照方案不复制 git 元数据
            if item.is_dir():
                shutil.copytree(item, workspace / item.name)
            else:
                shutil.copy2(item, workspace)
    # 基线快照供 diff 比对
    baseline = workspace / BASELINE_DIR
    baseline.mkdir()
    for item in workspace.iterdir():
        if item.name == BASELINE_DIR:
            continue
        if item.is_dir():
            shutil.copytree(item, baseline / item.name)
        else:
            shutil.copy2(item, baseline)
    return workspace


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


def make_workspace_tools(workspace: Path) -> list:
    """修复 agent 工具集：读写限定工作区内（11.2 执行侧权限收敛）。"""

    def resolve(path: str) -> Path:
        target = (workspace / path).resolve()
        if not str(target).startswith(str(workspace.resolve())):
            raise ValueError(f"路径越出工作区: {path}")
        return target

    @tool
    def read_file(path: str) -> str:
        """读取工作区内文件内容。"""
        target = resolve(path)
        if not target.is_file():
            return f"文件不存在: {path}"
        return target.read_text(encoding="utf-8")

    @tool
    def write_file(path: str, content: str) -> str:
        """写入/修改工作区内文件。"""
        target = resolve(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return f"已写入 {path}"

    @tool
    def list_dir(path: str = ".") -> str:
        """查看工作区目录结构。"""
        target = resolve(path)
        if not target.is_dir():
            return f"目录不存在: {path}"
        return "\n".join(sorted(p.name + ("/" if p.is_dir() else "") for p in target.iterdir()))

    @tool
    def git_diff() -> str:
        """查看当前修改相对基线的差异。"""
        _, diff = compute_diff(workspace)
        return diff or "(无变更)"

    return [read_file, write_file, list_dir, git_diff]


def diff_hash(diff: str) -> str:
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
