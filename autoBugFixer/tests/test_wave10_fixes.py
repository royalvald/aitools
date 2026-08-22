"""Wave10 小型已知限制修复测试：

- Docker exec_timeout 生效（Spec 06 §10）；
- 验证起点环境锁续期接线 + env_lock_renew 审计（Spec 06 §3.2）；
- VerifyRecord.evidence_uris 写入点：证据落盘文件（Spec 07 §8/§10）；
- 成功分支 LLM 归因分类 + 异常回退关键词规则（Spec 08 §7）。
"""

import json
import threading
from pathlib import Path

from sqlalchemy import select

from autobugfixer.adapters.env.docker import DockerExecutor
from autobugfixer.common.core.models import AuditLog, Experience, VerifyRecord
from autobugfixer.features.learning.schemas import ExperienceDigest
from autobugfixer.common.core.stage import TaskContext
from autobugfixer.common.core.state import TaskState


# ---------- Docker exec_timeout（Spec 06 §10） ----------

class _HangingContainer:
    """exec_run 永久阻塞的假容器（模拟容器内命令挂死）。"""

    def __init__(self):
        self.calls = 0

    def exec_run(self, cmd, workdir=None, demux=False):
        self.calls += 1
        threading.Event().wait(5)  # 远超被测超时（0.5s）
        return 0, (b"", b"")


def test_docker_exec_timeout_effective(monkeypatch):
    from types import SimpleNamespace

    container = _HangingContainer()
    client = SimpleNamespace(containers=SimpleNamespace(get=lambda name: container),
                             close=lambda: None)
    fake_docker = SimpleNamespace(from_env=lambda: client,
                                  DockerClient=lambda base_url=None: client)
    import sys
    monkeypatch.setitem(sys.modules, "docker", fake_docker)

    ex = DockerExecutor("app", whitelist=["echo {text}"], exec_timeout=0.5)
    result = ex.exec("echo hi")
    assert result.returncode == 124
    assert "超时" in result.stderr


# ---------- 锁续期接线（Spec 06 §3.2） ----------

def test_env_lock_renewed_at_verifying_start(make_orchestrator, session_factory,
                                             settings, repo, environment):
    from autobugfixer.adapters.platform import BugTicketData
    from autobugfixer.features.ingest.ingestion import ingest_bug

    data = BugTicketData(
        platform_bug_id="BUG-RN1", title="健康检查接口返回 fail",
        description="d", repro_steps="s", expected="ok", actual="fail",
        env_version="v1", repo_url=str(repo), affected_modules=["web"])
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        task_id = task.id

    assert make_orchestrator().run_until_blocked(task_id) == TaskState.CLOSED
    with session_factory() as s:
        renews = s.scalars(select(AuditLog).where(
            AuditLog.task_id == task_id,
            AuditLog.action == "env_lock_renew")).all()
        assert renews, "验证起点必须续期临界区租约"
        # 证据落盘：evidence_uris 非空且文件真实存在（Spec 07 §8）
        verify = s.scalar(select(VerifyRecord).where(
            VerifyRecord.task_id == task_id))
        assert verify.evidence_uris, "含证据步骤的验证必须落盘证据文件"
        evidence_file = Path(verify.evidence_uris[0])
        assert evidence_file.exists()
        payload = json.loads(evidence_file.read_text(encoding="utf-8"))
        assert payload["task_id"] == task_id
        assert any(step["evidence"] for step in payload["steps"])


# ---------- LLM 归因分类 + 回退（Spec 08 §7） ----------

def test_experience_llm_digest_fills_root_cause(make_orchestrator, session_factory,
                                                settings, repo, environment):
    from autobugfixer.adapters.platform import BugTicketData
    from autobugfixer.features.ingest.ingestion import ingest_bug

    data = BugTicketData(
        platform_bug_id="BUG-DG1", title="健康检查接口返回 fail",
        description="d", repro_steps="s", expected="ok", actual="fail",
        env_version="v1", repo_url=str(repo), affected_modules=["web"])
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        task_id = task.id

    assert make_orchestrator().run_until_blocked(task_id) == TaskState.CLOSED
    with session_factory() as s:
        exp = s.scalar(select(Experience))
        assert exp.category == "接口类"  # LLM 分类（fake 应答）
        assert exp.root_cause_pattern  # 根因沉淀不再恒空


def test_experience_digest_falls_back_on_llm_failure(
        make_orchestrator, session_factory, settings, repo, environment):
    """归因调用异常 -> 回退关键词分类、root_cause 留空，成功分支不中断。"""
    from autobugfixer.adapters.platform import BugTicketData
    from autobugfixer.features.fixing.codex import ScriptedCodexCLI
    from autobugfixer.adapters.env import LocalExecutor
    from autobugfixer.features.intervention.notifier import LogNotifier
    from autobugfixer.adapters.env.whitelist import CommandWhitelist
    from autobugfixer.common.core.models import BugTicket, Task
    from autobugfixer.runtime.orchestrator import Orchestrator
    from autobugfixer.features.learning.stage import LearningStage
    from autobugfixer.features.ingest.ingestion import ingest_bug
    from autobugfixer.common.core.llm import LLMGateway

    class FlakyLLM(LLMGateway):
        def analyze(self, prompt, schema, **kwargs):
            if schema is ExperienceDigest:
                raise RuntimeError("归因调用失败")
            return super().analyze(prompt, schema, **kwargs)

    data = BugTicketData(
        platform_bug_id="BUG-DG2", title="登录页面按钮显示错误",
        description="界面按钮文案错误", repro_steps="s", expected="ok",
        actual="fail", env_version="v1", repo_url=str(repo),
        affected_modules=["web"])
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        task_id = task.id

    llm = FlakyLLM(settings, session_factory)
    orchestrator = Orchestrator(
        session_factory, llm=llm, platform=make_orchestrator().platform,
        executor=LocalExecutor(settings.env_root, CommandWhitelist(settings.cmd_whitelist)),
        notifier=LogNotifier(), settings=settings, codex=ScriptedCodexCLI())
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED
    with session_factory() as s:
        exp = s.scalar(select(Experience))
        assert exp.category == "界面类"  # 关键词规则回退
        assert exp.root_cause_pattern == ""  # 不覆盖
