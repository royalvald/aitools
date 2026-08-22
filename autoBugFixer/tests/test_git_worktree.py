"""git 受控分支工作区测试：use_git_worktree 开启时走 git worktree + autofix 分支。"""

import shutil
import subprocess

import pytest
from sqlalchemy import select

from autobugfixer.core.models import FixRecord
from autobugfixer.core.state import TaskState

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git 不可用")


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True, check=True)


@pytest.fixture()
def git_repo(tmp_path):
    """本地临时 git 仓库（带 bug 的健康检查文件，已提交）。"""
    repo = tmp_path / "git-repo"
    (repo / "api").mkdir(parents=True)
    (repo / "api" / "health.json").write_text('{"status": "fail"}', encoding="utf-8")
    _git(repo, "init", "-b", "main")
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init")
    return repo


def test_git_worktree_full_pipeline(make_orchestrator, session_factory, platform,
                                    settings, environment, git_repo):
    settings.use_git_worktree = True
    bug = platform.list_bugs()[0]
    bug.repo_url = str(git_repo)
    bug.repo_branch = "main"

    from autobugfixer.ingest.ingestion import ingest_bug

    with session_factory() as s:
        task, _ = ingest_bug(s, bug)
        s.commit()
        task_id = task.id

    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED

    with session_factory() as s:
        fix = s.scalar(select(FixRecord).where(FixRecord.task_id == task_id))
        assert fix.branch == "autofix/BUG-T001"
        assert "api/health.json" in fix.changed_files
        assert '"status": "ok"' in fix.diff  # git diff 产出
    # 受控分支真实存在于仓库
    branches = _git(git_repo, "branch", "--list").stdout
    assert "autofix/BUG-T001" in branches


def test_git_worktree_fallback_for_non_git_repo(make_orchestrator, task_id,
                                                settings, environment):
    """开启开关但仓库非 git 时回退目录快照方案，行为不变。"""
    settings.use_git_worktree = True  # conftest repo 是普通目录
    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED
