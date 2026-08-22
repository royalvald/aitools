"""CSV 导入与预处理分析测试：解析、导入、导入+分析端到端、API 上传、CLI。"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from autobugfixer.platform import MockBugPlatform
from autobugfixer.ingest.csv_import import CsvFormatError, parse_csv
from autobugfixer.env import LocalExecutor
from autobugfixer.intervention.notifier import LogNotifier
from autobugfixer.env.whitelist import CommandWhitelist
from autobugfixer.api.app import create_app
from autobugfixer.cli import main as cli_main
from autobugfixer.core.models import AuditLog, Task, VerificationPlan
from autobugfixer.runtime.orchestrator import Orchestrator
from autobugfixer.core.state import TaskState
from autobugfixer.ingest.importer import analyze_tasks, import_bug_rows
from autobugfixer.core.llm import LLMGateway

EXAMPLE_CSV = Path(__file__).parent.parent / "examples" / "bugs_sample.csv"

HEADER = "bug_id,title,description,repro_steps,expected,actual,env_version,attachments,repo_url,repo_branch"


def _make_orchestrator(settings, session_factory, fake_responses=None):
    llm = LLMGateway(settings, session_factory, fake_responses=fake_responses)
    return Orchestrator(
        session_factory, llm=llm, platform=MockBugPlatform([]),
        executor=LocalExecutor(settings.env_root, CommandWhitelist(settings.cmd_whitelist)),
        notifier=LogNotifier(), settings=settings,
    )


# ---------- 解析 ----------

def test_parse_utf8_sig():
    content = f"{HEADER}\nBUG-1,标题一,描述,步骤,期望,实际,v1,,,\n".encode("utf-8-sig")
    parsed = parse_csv(content)
    assert len(parsed.rows) == 1
    assert parsed.rows[0].platform_bug_id == "BUG-1"
    assert parsed.rows[0].missing_fields == []


def test_parse_gbk():
    content = f"{HEADER}\nBUG-2,标题二,中文描述,步骤,期望,实际,v1,,,\n".encode("gbk")
    parsed = parse_csv(content)
    assert parsed.rows[0].title == "标题二"
    assert parsed.rows[0].description == "中文描述"


def test_parse_quoted_multiline_and_comma():
    row = 'BUG-3,"标题,含逗号","第一行\n第二行",步骤,期望,实际,v1,,,'
    parsed = parse_csv(f"{HEADER}\n{row}\n".encode("utf-8-sig"))
    bug = parsed.rows[0]
    assert bug.title == "标题,含逗号"
    assert bug.description == "第一行\n第二行"


def test_parse_alias_headers():
    header = "缺陷编号,标题,问题描述,复现步骤,期望结果,实际结果,环境版本,附件,仓库地址,分支"
    row = "BUG-4,别名标题,描述,步骤,期望,实际,v2,a.png;b.log,mock://repo,dev"
    parsed = parse_csv(f"{header}\n{row}\n".encode("utf-8-sig"))
    bug = parsed.rows[0]
    assert bug.platform_bug_id == "BUG-4"
    assert bug.attachments == ["a.png", "b.log"]
    assert bug.repo_branch == "dev"


def test_parse_missing_required_column():
    content = "bug_id,description\nBUG-5,只有描述\n".encode("utf-8-sig")
    with pytest.raises(CsvFormatError, match="必填列"):
        parse_csv(content)


def test_parse_empty_required_field_rows():
    rows = f"{HEADER}\n,BUG-6,描述,步骤,期望,实际,v1,,,\nBUG-7,,描述,步骤,期望,实际,v1,,,\n"
    parsed = parse_csv(rows.encode("utf-8-sig"))
    assert parsed.rows == []
    assert [(f.row, f.reason) for f in parsed.failures] == [
        (2, "bug_id 为空"), (3, "title 为空")]


def test_parse_missing_fields_marked():
    """空字段按 FR-PRE-01 保留空值并写入 missing_fields。"""
    content = f"{HEADER}\nBUG-8,只有标题,,,,,,,,\n".encode("utf-8-sig")
    bug = parse_csv(content).rows[0]
    assert set(bug.missing_fields) == {"description", "repro_steps",
                                       "expected", "actual", "env_version"}


# ---------- 导入 ----------

def test_import_result_structure_and_dedup(settings, session_factory):
    content = (
        f"{HEADER}\n"
        "BUG-10,标题A,描述,步骤,期望,实际,v1,,,\n"
        "BUG-10,标题A重复,描述,步骤,期望,实际,v1,,,\n"
        ",缺编号,,,,,,,,\n"
    ).encode("utf-8-sig")
    parsed = parse_csv(content)
    with session_factory() as s:
        result = import_bug_rows(s, parsed, source="test.csv")
        s.commit()
        assert result["total"] == 3
        assert result["imported"] == 1
        assert result["skipped"] == 1  # 同 platform 重复 bug_id 幂等跳过
        assert result["failed"] == [{"row": 4, "reason": "bug_id 为空"}]
        assert len(result["task_ids"]) == 1
        # 导入动作已审计
        audit = s.scalar(select(AuditLog).where(AuditLog.action == "csv_import"))
        assert audit is not None and audit.detail["imported"] == 1


# ---------- 导入 + 预处理分析端到端 ----------

def _mk_repo(tmp_path, name: str = "repo-a") -> Path:
    """构造可用的本地关联仓库（非 git 非空目录，Spec 01 §9 B9-5b）。"""
    repo = tmp_path / name
    repo.mkdir(parents=True, exist_ok=True)
    (repo / "api").mkdir(exist_ok=True)
    (repo / "api" / "health.json").write_text('{"status": "fail"}', encoding="utf-8")
    return repo


def test_import_and_analysis_end_to_end(settings, session_factory, tmp_path):
    """完整 Bug（含可用仓库）停在 SCORED；信息不完整/缺仓库分别停在 WAIT_INFO。"""
    repo = _mk_repo(tmp_path)
    content = (
        f"{HEADER}\n"
        f"BUG-2001,健康检查接口返回 fail,描述,步骤,期望,实际,v1,,{repo},\n"
        f"BUG-2002,首页打开白屏,用户反馈白屏,,,,,screenshot.png;,{repo},\n"
        f"BUG-2003,列表页分页报错,描述,步骤,期望,实际,v2,,,\n"
    ).encode("utf-8-sig")
    parsed = parse_csv(content)
    assert len(parsed.rows) == 3
    with session_factory() as s:
        result = import_bug_rows(s, parsed, source="inline.csv")
        s.commit()
    orchestrator = _make_orchestrator(settings, session_factory)
    summaries = analyze_tasks(orchestrator, session_factory, result["task_ids"])

    states = {item["bug_id"]: item["state"] for item in summaries}
    assert states["BUG-2002"] == "WAIT_INFO"           # 信息不完整（仓库可用）
    assert states["BUG-2003"] == "WAIT_INFO"           # 未关联仓库（Spec 01 §9 B9-6）
    assert states["BUG-2001"] == "SCORED"              # 准入入队，未进入 FIXING
    for item in summaries:
        assert item["state"] in {"SCORED", "MANUAL", "WAIT_INFO", "WAIT_PLAN"}
        if item["state"] == "SCORED":
            assert item["risk_level"] == "low"
            assert item["scores"] is not None
            assert 0 <= item["priority_score"] < 60
            assert item["admission"] == "入队"

    # 方案与评分落库（仅放行任务）；缺仓库任务 0 次 LLM 调用
    with session_factory() as s:
        plans = s.scalars(select(VerificationPlan)).all()
        assert len(plans) == 1  # 两个 WAIT_INFO 的 Bug 未生成方案
        from autobugfixer.core.models import BugRepo, LLMUsage

        repos = s.scalars(select(BugRepo).order_by(BugRepo.seq)).all()
        assert [(r.path, r.branch, r.status) for r in repos] == [
            (str(repo), "main", "available"),   # BUG-2001
            (str(repo), "main", "available"),   # BUG-2002
        ]  # BUG-2003 无关联仓库行
        # 门禁拦截的两个 WAIT_INFO 任务 0 次 LLM 调用（Spec 01 R6：不消耗 LLM 成本）
        blocked_task_ids = [t.id for t in s.scalars(select(Task).where(
            Task.state == "WAIT_INFO")).all()]
        used_task_ids = {u.task_id for u in s.scalars(select(LLMUsage)).all()}
        assert used_task_ids and used_task_ids.isdisjoint(blocked_task_ids)


def test_analysis_high_score_to_manual(settings, session_factory, tmp_path):
    """评分超阈值 -> MANUAL（用 fake_responses 队列注入高分）。"""
    repo = _mk_repo(tmp_path)
    content = (f"{HEADER}\nBUG-20,复杂缺陷,描述,步骤,期望,实际,v1,,{repo},\n"
               ).encode("utf-8-sig")
    parsed = parse_csv(content)
    with session_factory() as s:
        result = import_bug_rows(s, parsed)
        s.commit()
    fake_responses = [
        {"complete": True, "missing": [], "suggestions": []},
        {"env_requirements": "env", "steps": [
            {"action": "open_page", "params": {"url": "/index"}},
            {"action": "call_api", "params": {"method": "GET", "path": "/health"}},
            {"action": "assert_response",
             "params": {"json_path": "status", "expect": "never-match"}}],
         "expected_results": [], "function_points": [], "regression_scope": ""},
        {"fix_difficulty": 95, "verify_difficulty": 90, "change_scale": 92,
         "rationale": "核心链路复杂缺陷"},
    ]
    orchestrator = _make_orchestrator(settings, session_factory, fake_responses)
    summaries = analyze_tasks(orchestrator, session_factory, result["task_ids"])
    assert summaries[0]["state"] == "MANUAL"
    assert summaries[0]["admission"] == "转人工"
    assert summaries[0]["priority_score"] >= 60


# ---------- API 上传 ----------

@pytest.fixture()
def api_client(settings):
    return TestClient(create_app(settings, platform=MockBugPlatform([])))


def test_api_import_csv(api_client, tmp_path):
    repo = _mk_repo(tmp_path)
    content = (
        f"{HEADER}\n"
        f"BUG-30,接口超时,描述,步骤,期望,实际,v1,,{repo},\n"
        f"BUG-31,标题缺失信息,,,,,,,,\n"
    ).encode("utf-8-sig")
    resp = api_client.post(
        "/api/import/csv",
        files={"file": ("bugs.csv", content, "text/csv")},
        data={"run_analysis": "true"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2 and body["imported"] == 2
    states = {item["bug_id"]: item["state"] for item in body["analysis"]}
    assert states["BUG-30"] == "SCORED"
    assert states["BUG-31"] == "WAIT_INFO"


def test_api_import_csv_bad_format(api_client):
    resp = api_client.post(
        "/api/import/csv",
        files={"file": ("bad.csv", "a,b,c\n1,2,3\n".encode(), "text/csv")},
    )
    assert resp.status_code == 400


# ---------- CLI ----------

def test_cli_import_with_analysis(settings, tmp_path, capsys):
    repo = _mk_repo(tmp_path)
    csv_path = tmp_path / "bugs.csv"
    csv_path.write_bytes(
        f"{HEADER}\nBUG-40,CLI导入,描述,步骤,期望,实际,v1,,{repo},\n".encode("utf-8-sig"))
    rc = cli_main([str(csv_path), "--run-analysis"], settings=settings)
    assert rc == 0
    out = capsys.readouterr().out
    assert '"imported": 1' in out
    assert '"state": "SCORED"' in out  # 预处理分析汇总，未进入修复


def test_cli_bad_file(settings, tmp_path, capsys):
    csv_path = tmp_path / "bad.csv"
    csv_path.write_bytes("x,y\n1,2\n".encode())
    assert cli_main([str(csv_path)], settings=settings) == 2
