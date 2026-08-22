"""评分准入测试（FR-PRE-04）：低于阈值入队 / 高于阈值转人工；权重可配。

补齐 Spec 04 §7 规则覆盖矩阵缺口：plan_summary 截断（B1-3）、无方案占位
（B1-4）、越界分数重试耗尽转 FAILED（B3-1/B3-2）、策略部分合并（B4-2）、
developer 通知（B5-2）、admission_hold 审计（B6-1）。
"""

from sqlalchemy import select

from autobugfixer.intervention.notifier import LogNotifier, NoticeMessage
from autobugfixer.core.models import AuditLog, BugTicket, StrategyVersion, Task, VerificationPlan
from autobugfixer.scoring.schemas import ScoreOutput
from autobugfixer.core.stage import TaskContext
from autobugfixer.scoring.stage import ScoringStage
from autobugfixer.core.state import TaskState
from autobugfixer.core.audit import AuditService
from autobugfixer.env.lock import EnvLockService
from autobugfixer.intervention.service import InterventionService


def _score_responses(fix: float, verify: float, change: float) -> list:
    """按调用顺序编排 fake 应答：完整性 -> 方案 -> 评分（四段式合法方案）。"""
    return [
        {"complete": True, "missing": [], "suggestions": []},
        {"env_requirements": "本地仿真环境",
         "steps": [{"action": "input", "params": {"selector": "#env", "value": "v1"},
                    "desc": "确认环境版本"},
                   {"action": "call_api", "params": {"method": "GET", "path": "/health"}},
                   {"action": "assert_response",
                    "params": {"json_path": "status", "expect": "ok"}}],
         "expected_results": ["ok"], "function_points": ["健康检查"], "regression_scope": "接口"},
        {"fix_difficulty": fix, "verify_difficulty": verify, "change_scale": change,
         "rationale": "测试用评分"},
    ]


def test_low_score_admitted(make_orchestrator, task_id, session_factory):
    """综合分 20*0.4+15*0.3+10*0.3=15.5 < 60 -> 进入自动修复（最终 CLOSED）。"""
    orchestrator = make_orchestrator(_score_responses(20, 15, 10))
    final = orchestrator.run_until_blocked(task_id)
    with session_factory() as s:
        from autobugfixer.core.models import Task
        task = s.get(Task, task_id)
        assert task.priority_score == 15.5
        assert task.score_detail["rationale"] == "测试用评分"
        assert task.score_detail["weights"]["version"] == "v1"
    assert final == TaskState.CLOSED


def test_high_score_to_manual(make_orchestrator, task_id, session_factory):
    """综合分 90 >= 60 -> 转 MANUAL 并附评分解释。"""
    orchestrator = make_orchestrator(_score_responses(90, 90, 90))
    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.MANUAL
    with session_factory() as s:
        from autobugfixer.core.models import Task
        task = s.get(Task, task_id)
        assert task.priority_score == 90.0
        assert task.score_detail["threshold"] == 60.0


def test_weights_configurable(make_orchestrator, task_id, session_factory, settings):
    """权重可配置：调整权重改变综合分。"""
    settings.score_weight_fix = 1.0
    settings.score_weight_verify = 0.0
    settings.score_weight_change = 0.0
    orchestrator = make_orchestrator(_score_responses(70, 0, 0))  # 70*1.0=70 >= 60
    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.MANUAL


def test_scoring_prompt_includes_plan_summary(session_factory, settings, task_id, platform):
    """评分 prompt 从库读取最新验证方案摘要（修复 ctx.data 跨阶段失效）。"""

    class RecordingLLM:
        def __init__(self):
            self.prompts = []

        def analyze(self, prompt, schema, *, task_id, stage, session=None):
            self.prompts.append(prompt)
            return schema(fix_difficulty=20, verify_difficulty=15,
                          change_scale=10, rationale="测试评分")

    with session_factory() as s:
        s.add(VerificationPlan(task_id=task_id, steps=[
            {"action": "call_api", "params": {"method": "GET", "path": "/health"},
             "desc": "调用健康检查接口"},
            {"action": "assert_response",
             "params": {"json_path": "status", "expect": "ok"},
             "desc": "断言 status 为 ok"},
        ], expected_results=["status 为 ok"]))
        s.commit()

    with session_factory() as s:
        task = s.get(Task, task_id)
        bug = s.get(BugTicket, task.bug_ticket_id)
        llm = RecordingLLM()
        ctx = TaskContext(
            task=task, bug=bug, session=s, settings=settings, llm=llm,
            platform=platform, executor=None, notifier=LogNotifier(),
            audit=AuditService(s), interventions=InterventionService(s),
            env_locks=EnvLockService(s, lease_seconds=60),
        )
        result = ScoringStage().run(ctx)
        assert result.status == "success"
        prompt = llm.prompts[-1]
        assert "验证方案摘要" in prompt
        assert "调用健康检查接口" in prompt
        assert "断言 status 为 ok" in prompt
        assert "预期: status 为 ok" in prompt


# ---------- Spec 04 §7 缺口补充 ----------

def _summary_section(prompt: str) -> str:
    """从评分 prompt 中切出"验证方案摘要"与"维度"之间的方案摘要段。"""
    _, rest = prompt.split("验证方案摘要：\n", 1)
    return rest.split("\n\n维度", 1)[0]


class _RecordingLLM:
    """记录 prompt 并返回固定评分的 LLM 替身（stage 直测用）。"""

    def __init__(self):
        self.prompts: list[str] = []

    def analyze(self, prompt, schema, *, task_id, stage, session=None):
        self.prompts.append(prompt)
        return schema(fix_difficulty=20, verify_difficulty=15,
                      change_scale=10, rationale="测试评分")


def _make_ctx(session_factory, settings, task_id, platform):
    from autobugfixer.core.stage import TaskContext

    s = session_factory()
    task = s.get(Task, task_id)
    bug = s.get(BugTicket, task.bug_ticket_id)
    ctx = TaskContext(
        task=task, bug=bug, session=s, settings=settings, llm=_RecordingLLM(),
        platform=platform, executor=None, notifier=LogNotifier(),
        audit=AuditService(s), interventions=InterventionService(s),
        env_locks=EnvLockService(s, lease_seconds=60),
    )
    return ctx, s


def test_scoring_prompt_truncates_plan_summary(session_factory, settings,
                                               task_id, platform):
    """B1-3：超长方案摘要整体截断 500 字符进入评分证据。"""
    long_desc = "A" * 100
    with session_factory() as s:
        s.add(VerificationPlan(task_id=task_id, steps=[
            {"action": "call_api", "params": {"method": "GET", "path": "/h"},
             "desc": long_desc} for _ in range(10)],
            expected_results=["ok"]))
        s.commit()

    ctx, s = _make_ctx(session_factory, settings, task_id, platform)
    try:
        assert ScoringStage().run(ctx).status == "success"
        summary = _summary_section(ctx.llm.prompts[-1])
        assert len(summary) == 500  # 1000+ 字符摘要被截断
        assert "预期" not in summary  # 连同预期行一起截掉
    finally:
        s.close()


def test_scoring_prompt_placeholder_when_no_plan(session_factory, settings,
                                                 task_id, platform):
    """B1-4：无验证方案时以"见验证方案"占位继续评分（防御路径不阻断）。"""
    ctx, s = _make_ctx(session_factory, settings, task_id, platform)
    try:
        assert ScoringStage().run(ctx).status == "success"
        assert _summary_section(ctx.llm.prompts[-1]) == "见验证方案"
    finally:
        s.close()


def test_out_of_range_score_retries_then_failed(make_orchestrator, task_id,
                                                session_factory):
    """B3-1/B3-2：越界分数被 Schema 拒绝重试，3 次耗尽 -> FAILED 断点续跑。"""
    bad_score = {"fix_difficulty": 120, "verify_difficulty": 15,
                 "change_scale": 10, "rationale": "越界"}
    orchestrator = make_orchestrator(_score_responses(20, 15, 10)[:2] + [bad_score] * 3)
    final = orchestrator.run_until_blocked(task_id)
    assert final == TaskState.FAILED
    with session_factory() as s:
        task = s.get(Task, task_id)
        assert task.priority_score is None  # 评分未落库
        exc = s.scalar(select(AuditLog).where(
            AuditLog.task_id == task_id, AuditLog.action == "stage_exception"))
        assert exc.detail["stage"] == "scoring"


def test_strategy_partial_merge_keeps_config_defaults(make_orchestrator, task_id,
                                                      session_factory):
    """B4-2：生效策略只覆盖出现的权重键，缺的键沿用配置默认；阈值同理。"""
    with session_factory() as s:
        s.add(StrategyVersion(version=1, active=True, weights={"fix": 0.5}))
        s.commit()

    assert make_orchestrator().run_until_blocked(task_id) == TaskState.CLOSED
    with session_factory() as s:
        detail = s.get(Task, task_id).score_detail
        # fake 默认评分 20/15/10 -> 20*0.5 + 15*0.3 + 10*0.3 = 17.5
        assert detail["weights"] == {"fix": 0.5, "verify": 0.3, "change": 0.3,
                                     "version": "strategy:v1"}
        assert detail["threshold"] == 60.0  # 策略未给 threshold -> 配置默认
        assert s.get(Task, task_id).priority_score == 17.5


def test_high_score_notifies_developer_with_score_detail(make_orchestrator, task_id):
    """B5-2：超阈值转 MANUAL 时通知 developer，标题含分数、内容为评分明细。"""
    notifications: list[tuple[str, NoticeMessage]] = []

    class RecordingNotifier:
        def send(self, role, message):
            notifications.append((role, message))

    orchestrator = make_orchestrator(_score_responses(90, 90, 90),
                                     notifier=RecordingNotifier())
    assert orchestrator.run_until_blocked(task_id) == TaskState.MANUAL
    developer_notices = [m for role, m in notifications if role == "developer"]
    assert developer_notices, "超阈值必须通知 developer"
    notice = developer_notices[0]
    assert "BUG-T001" in notice.title and "90.0" in notice.title and "转人工" in notice.title
    assert "threshold" in notice.content and len(notice.content) <= 500  # 明细截断 500


def test_preprocessing_hold_writes_admission_hold_audit(make_orchestrator, task_id,
                                                        session_factory):
    """B6-1：预处理模式评分准入后停 SCORED 并写 admission_hold 审计（held_next=FIXING）。"""
    assert make_orchestrator().run_preprocessing(task_id) == TaskState.SCORED
    with session_factory() as s:
        holds = s.scalars(select(AuditLog).where(
            AuditLog.task_id == task_id,
            AuditLog.action == "admission_hold")).all()
        assert holds and holds[-1].detail["held_next"] == TaskState.FIXING.value
        assert s.get(Task, task_id).state == TaskState.SCORED.value  # 未进入修复
