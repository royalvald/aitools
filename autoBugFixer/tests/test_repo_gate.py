"""修复关联仓库要求测试（Spec 01 §9 P1：切分/校验/门禁/唤醒/工作区改造）。"""

import json
import shutil
import subprocess

import pytest
from sqlalchemy import select

from autobugfixer.adapters.bug_platform import BugTicketData
from autobugfixer.adapters.codex_cli import ScriptedCodexCLI
from autobugfixer.models import AuditLog, BugRepo, BugTicket, FixRecord, Task
from autobugfixer.pipeline.state import TaskState
from autobugfixer.services.ingestion import ingest_bug
from autobugfixer.services.intervention import InterventionService
from autobugfixer.services.repo_check import check_repo, split_repos

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git 不可用")


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True, check=True)


@pytest.fixture()
def git_repo(tmp_path):
    """本地临时 git 仓库（main 分支有提交）。"""
    repo = tmp_path / "git-repo"
    repo.mkdir(parents=True)
    (repo / "app.py").write_text("print('bug')", encoding="utf-8")
    _git(repo, "init", "-b", "main")
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init")
    return repo


def _bug(bug_id="BUG-RG1", repo_url="", repo_branch="") -> BugTicketData:
    return BugTicketData(
        platform_bug_id=bug_id, title="健康检查接口返回 fail",
        description="d", repro_steps="s", expected="ok", actual="fail",
        env_version="v1", repo_url=repo_url, repo_branch=repo_branch,
        affected_modules=["web"])


def _ingest(session_factory, data, settings) -> int:
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        return task.id


# ---------- 切分约定（§9.2） ----------

def test_split_repos_single_multi_and_empty():
    assert split_repos("E:\\repos\\svc-a", "dev") == [("E:\\repos\\svc-a", "dev")]
    # 多路径按位对应；分支不足位补 main（B9-2）
    assert split_repos("E:\\repos\\a;E:\\repos\\b", "dev") == [
        ("E:\\repos\\a", "dev"), ("E:\\repos\\b", "main")]
    assert split_repos("  ;E:\\repos\\a ; ", "") == [("E:\\repos\\a", "main")]
    assert split_repos("", "dev") == []  # 空值 -> 0 个关联（B9-3）


# ---------- 可用性校验（§9.3） ----------

def test_check_repo_statuses(tmp_path, git_repo):
    # 路径不存在 / 指向文件 / 远程 URL（B9-5c）
    assert check_repo(str(tmp_path / "nope"), "main").reason == "路径不存在"
    a_file = tmp_path / "file.txt"
    a_file.write_text("x", encoding="utf-8")
    assert check_repo(str(a_file), "main").reason.startswith("非目录")
    assert "远程地址" in check_repo("https://git.example.com/a.git", "main").reason
    assert "远程地址" in check_repo("git@example.com:a/b.git", "main").reason

    # git 仓库：分支在 = 可用；分支缺 = 不可用（B9-5a）
    ok = check_repo(str(git_repo), "main")
    assert ok.is_git and ok.ok
    missing = check_repo(str(git_repo), "feature-x")
    assert missing.is_git and not missing.ok and "分支缺失" in missing.reason

    # 非 git 目录：非空可用 / 空目录不可用（B9-5b）
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "a.txt").write_text("x", encoding="utf-8")
    assert check_repo(str(plain), "main").ok
    empty = tmp_path / "empty"
    empty.mkdir()
    assert check_repo(str(empty), "main").reason == "空目录"


# ---------- 接入持久化 + 审计（§9.3 R6） ----------

def test_ingest_persists_repo_rows_and_audit(session_factory, settings, tmp_path):
    repo_a = tmp_path / "svc-a"
    repo_a.mkdir()
    (repo_a / "f.txt").write_text("x", encoding="utf-8")
    task_id = _ingest(session_factory, _bug(repo_url=f"{repo_a};{tmp_path / 'gone'}"),
                      settings)
    with session_factory() as s:
        rows = s.scalars(select(BugRepo).order_by(BugRepo.seq)).all()
        assert [(r.path, r.branch, r.status, r.fail_reason) for r in rows] == [
            (str(repo_a), "main", "available", ""),
            (str(tmp_path / "gone"), "main", "unavailable", "路径不存在")]
        audit = s.scalar(select(AuditLog).where(AuditLog.action == "task_ingest",
                                                AuditLog.task_id == task_id))
        assert audit.detail["repo_check"][1]["status"] == "unavailable"


# ---------- 门禁：缺仓库/不可用 -> WAIT_INFO + repo_supplement（B9-6） ----------

def test_missing_repo_blocks_with_repo_supplement(
        make_orchestrator, session_factory, settings, environment):
    task_id = _ingest(session_factory, _bug(repo_url=""), settings)
    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.WAIT_INFO

    from autobugfixer.models import Intervention, LLMUsage
    with session_factory() as s:
        intervention = s.scalar(select(Intervention).where(
            Intervention.task_id == task_id))
        assert intervention.type == "repo_supplement"
        assert intervention.assignee_role == "tester"
        assert intervention.context["missing_repos"][0]["reason"] == "未关联任何修复仓库"
        # 不消耗 LLM 成本（Spec 01 R6）
        assert s.scalars(select(LLMUsage).where(LLMUsage.task_id == task_id)).all() == []


def test_unavailable_repo_blocks_before_llm(make_orchestrator, session_factory,
                                            settings, environment, tmp_path):
    task_id = _ingest(session_factory, _bug(repo_url=str(tmp_path / "gone")), settings)
    assert make_orchestrator().run_until_blocked(task_id) == TaskState.WAIT_INFO


# ---------- 唤醒：平台重导补全仓库 -> 放行闭环（§9.4） ----------

def test_reimport_with_repo_wakes_and_closes(make_orchestrator, session_factory,
                                             settings, environment, repo):
    task_id = _ingest(session_factory, _bug(repo_url=""), settings)
    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.WAIT_INFO

    # 平台侧重导（复用 B6-3 字段刷新 + B6-4 唤醒），补上可用仓库
    with session_factory() as s:
        task, created = ingest_bug(s, _bug(repo_url=str(repo)), max_retry=3)
        s.commit()
        assert created is False
        assert task.info_rounds == 1
        assert TaskState(task.state) == TaskState.ANALYZING
        rows = s.scalars(select(BugRepo)).all()
        assert len(rows) == 1 and rows[0].status == "available"  # 复检通过
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED


def test_repo_supplement_resolve_wakes(make_orchestrator, session_factory,
                                       settings, environment, repo):
    """人工回写 repo_supplement（fields 携带仓库地址）-> 合并 + 复检 + 唤醒。"""
    task_id = _ingest(session_factory, _bug(repo_url=""), settings)
    orchestrator = make_orchestrator()
    assert orchestrator.run_until_blocked(task_id) == TaskState.WAIT_INFO

    from autobugfixer.models import Intervention
    with session_factory() as s:
        intervention = s.scalar(select(Intervention).where(
            Intervention.task_id == task_id, Intervention.status == "pending"))
        InterventionService(s).resolve(intervention.id, {"fields": {
            "repo_url": str(repo), "repo_branch": "main"}})
        s.commit()
        bug = s.scalar(select(BugTicket).where(BugTicket.id == s.get(Task, task_id).bug_ticket_id))
        assert bug.repo_url == str(repo)
        rows = s.scalars(select(BugRepo)).all()
        assert len(rows) == 1 and rows[0].status == "available"
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED


# ---------- prepare_workspace 改造（§9.5） ----------

def test_prepare_workspace_multi_repo_subdir_layout(
        make_orchestrator, session_factory, settings, environment, tmp_path):
    repo_a = tmp_path / "svc-a"
    repo_b = tmp_path / "svc-b"
    for repo in (repo_a, repo_b):
        (repo / "api").mkdir(parents=True)
        (repo / "api" / "health.json").write_text('{"status": "fail"}', encoding="utf-8")
    task_id = _ingest(session_factory, _bug(repo_url=f"{repo_a};{repo_b}"), settings)
    # 桩在两个仓库子目录内各修一份，并补一份环境根级仿真产物（供 call_api 映射读取）
    stub = ScriptedCodexCLI(writes={
        "svc-a/api/health.json": '{"status": "ok"}',
        "svc-b/api/health.json": '{"status": "ok"}',
        "api/health.json": '{"status": "ok"}',
    })
    orchestrator = make_orchestrator(codex=stub)
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED

    with session_factory() as s:
        fix = s.scalar(select(FixRecord).where(FixRecord.task_id == task_id))
        # 仓库内变更路径落在仓库名子目录下（多仓库子目录布局）
        assert {"svc-a/api/health.json", "svc-b/api/health.json"} <= set(fix.changed_files)
    # 两个仓库的产物都部署进了环境
    for name in ("svc-a", "svc-b"):
        deployed = tmp_path / "testenv" / name / "api" / "health.json"
        assert json.loads(deployed.read_text(encoding="utf-8"))["status"] == "ok"


def test_fixing_without_repo_rows_fails_explicitly(
        make_orchestrator, session_factory, settings, environment, repo):
    """仓库行缺失（数据异常）时修复阶段显式 FAILED，不再静默建空工作区。"""
    task_id = _ingest(session_factory, _bug(repo_url=str(repo)), settings)
    orchestrator = make_orchestrator()
    assert orchestrator.run_preprocessing(task_id) == TaskState.SCORED
    with session_factory() as s:
        s.query(BugRepo).delete()  # 模拟仓库关联数据丢失
        s.commit()
    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.FAILED


def test_fixing_with_deleted_repo_dir_fails(
        make_orchestrator, session_factory, settings, environment, tmp_path):
    """接入后仓库目录被删：修复阶段显式失败兜底（§9.4 接入后不复检）。"""
    repo = tmp_path / "vanishing"
    repo.mkdir()
    (repo / "f.txt").write_text("x", encoding="utf-8")
    task_id = _ingest(session_factory, _bug(repo_url=str(repo)), settings)
    orchestrator = make_orchestrator()
    assert orchestrator.run_preprocessing(task_id) == TaskState.SCORED
    shutil.rmtree(repo)  # 接入后目录被删除
    assert orchestrator.run_until_blocked(task_id) == TaskState.FAILED
