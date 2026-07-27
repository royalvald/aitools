"""测试公共夹具：tmp SQLite + Fake LLM + Mock 平台 + LocalExecutor。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from autobugfixer.adapters.bug_platform import BugTicketData, MockBugPlatform
from autobugfixer.adapters.env_executor import LocalExecutor
from autobugfixer.adapters.notifier import LogNotifier
from autobugfixer.adapters.whitelist import CommandWhitelist
from autobugfixer.config import Settings
from autobugfixer.db import init_db, make_engine, make_session_factory
from autobugfixer.models import Environment
from autobugfixer.pipeline.orchestrator import Orchestrator
from autobugfixer.services.ingestion import ingest_bug
from autobugfixer.services.llm_gateway import LLMGateway


@pytest.fixture()
def settings(tmp_path) -> Settings:
    return Settings(
        database_url=f"sqlite:///{tmp_path}/test.db",
        llm_mode="fake",
        workspace_root=str(tmp_path / "workspaces"),
        env_root=str(tmp_path / "testenv"),
        cmd_whitelist=["echo {text}"],
    )


@pytest.fixture()
def session_factory(settings):
    engine = make_engine(settings.database_url)
    init_db(engine)
    return make_session_factory(engine)


@pytest.fixture()
def repo(tmp_path) -> Path:
    """模拟代码仓库：带 bug 的健康检查接口文件。"""
    repo_dir = tmp_path / "repo"
    (repo_dir / "api").mkdir(parents=True)
    (repo_dir / "api" / "health.json").write_text(
        json.dumps({"status": "fail"}), encoding="utf-8")
    return repo_dir


@pytest.fixture()
def bug(repo) -> BugTicketData:
    return BugTicketData(
        platform_bug_id="BUG-T001",
        title="健康检查接口返回 fail",
        description="测试环境 /health 接口返回 status=fail，应为 ok。",
        repro_steps="1. 部署应用\n2. 调用 GET /health\n3. 观察 status 字段",
        expected="status 为 ok",
        actual="status 为 fail",
        env_version="v1.0.0",
        repo_url="",  # 测试内填充
        affected_modules=["web"],
    )


@pytest.fixture()
def platform(bug, repo) -> MockBugPlatform:
    bug.repo_url = str(repo)
    return MockBugPlatform([bug])


@pytest.fixture()
def environment(session_factory) -> Environment:
    with session_factory() as s:
        env = Environment(name="local-test", type="local",
                          deploy_script=["echo deploying"], cmd_whitelist=["echo {text}"])
        s.add(env)
        s.commit()
        return env


@pytest.fixture()
def make_orchestrator(settings, session_factory, platform):
    """编排器工厂：可注入 fake_responses 控制 LLM 输出，可附加 Orchestrator 参数。"""

    def _make(fake_responses: list | None = None, **orch_kwargs) -> Orchestrator:
        llm = LLMGateway(settings, session_factory, fake_responses=fake_responses)
        executor = LocalExecutor(settings.env_root, CommandWhitelist(settings.cmd_whitelist))
        return Orchestrator(
            session_factory, llm=llm, platform=platform, executor=executor,
            notifier=LogNotifier(), settings=settings, **orch_kwargs,
        )

    return _make


@pytest.fixture()
def task_id(session_factory, platform, settings, environment) -> int:
    """已接入的标准任务（ANALYZING 状态）。"""
    data = platform.list_bugs()[0]
    with session_factory() as s:
        task, created = ingest_bug(s, data, max_retry=settings.max_retry)
        assert created
        s.commit()
        return task.id
