"""验证技能库测试（Spec 03 §8：提议 -> 内联落库 -> 蒸馏入库 -> 复用渲染与计量）。"""

import json

from sqlalchemy import select

from autobugfixer.platform import BugTicketData
from autobugfixer.fixing.codex import ScriptedCodexCLI
from autobugfixer.intervention.notifier import LogNotifier
from autobugfixer.core.models import AuditLog, Task, VerificationPlan, VerificationSkill
from autobugfixer.planning.schemas import PlanOutput
from autobugfixer.core.stage import TaskContext
from autobugfixer.planning.stage import PlanningStage
from autobugfixer.core.state import TaskState
from autobugfixer.core.audit import AuditService
from autobugfixer.env.lock import EnvLockService
from autobugfixer.ingest.ingestion import ingest_bug
from autobugfixer.intervention.service import InterventionService
from autobugfixer.knowledge.skill import SkillService, render_skill_library

# 组合校验技能模板：环境健康冒烟检查（3 步，占位符 {env}/{path}）
SMOKE_SKILL = {
    "name": "env_smoke_check",
    "params": ["env", "path"],
    "desc": "环境健康冒烟检查：确认环境后调用目标接口并断言 ok",
    "steps": [
        {"action": "input", "params": {"selector": "#env", "value": "{env}"},
         "desc": "确认环境 {env}"},
        {"action": "call_api", "params": {"method": "GET", "path": "{path}"},
         "desc": "调用 {path}"},
        {"action": "assert_response",
         "params": {"json_path": "status", "expect": "ok"}, "desc": "断言 status 为 ok"},
    ],
}

# 方案：内联展开该技能（实参替换占位符）+ 一条复测断言
PLAN_WITH_PROPOSAL = {
    "env_requirements": "本地仿真环境",
    "steps": [
        {"action": "input", "params": {"selector": "#env", "value": "v1.0.0"},
         "desc": "确认环境"},
        {"action": "call_api", "params": {"method": "GET", "path": "/health"},
         "desc": "调用健康检查接口"},
        {"action": "assert_response",
         "params": {"json_path": "status", "expect": "ok"}, "desc": "断言 status 为 ok"},
    ],
    "expected_results": ["status 为 ok"],
    "function_points": ["健康检查"],
    "regression_scope": "接口回归",
    "fix_approach": {"locate_hints": [], "change_files": ["api/health.json"],
                     "strategy": "修正 status"},
    "proposed_skills": [SMOKE_SKILL],
}


def _ingest(session_factory, settings, repo, bug_id="BUG-SK1") -> int:
    data = BugTicketData(
        platform_bug_id=bug_id, title="健康检查接口返回 fail",
        description="d", repro_steps="s", expected="ok", actual="fail",
        env_version="v1", repo_url=str(repo), affected_modules=["web"])
    with session_factory() as s:
        task, _ = ingest_bug(s, data, max_retry=settings.max_retry)
        s.commit()
        return task.id


def _planning_responses():
    return [
        {"complete": True, "missing": [], "suggestions": []},
        PLAN_WITH_PROPOSAL,
    ]


# ---------- 提议 -> 内联落库（首次使用不进技能库） ----------

def test_proposed_skill_inline_only_then_distilled_after_verify(
        make_orchestrator, session_factory, settings, repo, environment):
    task_id = _ingest(session_factory, settings, repo)
    orchestrator = make_orchestrator(_planning_responses())
    assert orchestrator.run_until_blocked(task_id) == TaskState.CLOSED

    with session_factory() as s:
        plan = s.scalar(select(VerificationPlan).where(
            VerificationPlan.task_id == task_id))
        # 提议快照随 plan 落库；方案步骤为展开后的原始步骤（可执行）
        assert [p["name"] for p in plan.proposed_skills] == ["env_smoke_check"]
        assert plan.steps[1]["params"]["path"] == "/health"
        # 验证通过 -> 蒸馏入库（version=1，来源任务记录）
        skill = s.scalar(select(VerificationSkill).where(
            VerificationSkill.name == "env_smoke_check"))
        assert skill is not None
        assert skill.version == 1
        assert skill.params_signature == "env, path"
        assert skill.template_steps[0]["params"]["value"] == "{env}"  # 模板保留占位符
        assert skill.source_task_ids == [task_id]
        actions = [a.action for a in s.scalars(select(AuditLog).where(
            AuditLog.task_id == task_id)).all()]
        assert "skill_proposed" in actions
        assert "skill_distilled" in actions


# ---------- 复用：{skill_library} 渲染 + 引用计量 ----------

def test_skill_library_rendered_into_planning_prompt(
        session_factory, settings, task_id, platform):
    """库内技能渲染进 planning prompt 动态段（RecordingLLM 捕获）。"""
    with session_factory() as s:
        SkillService(s).upsert(name="env_smoke_check", params=["env", "path"],
                               desc="环境健康冒烟检查",
                               template_steps=SMOKE_SKILL["steps"], source_task_id=task_id)
        s.commit()

    prompts: list[str] = []

    class RecordingLLM:
        def analyze(self, prompt, schema, *args, **kwargs):
            prompts.append(prompt)
            return PlanOutput(steps=[
                {"action": "input", "params": {"selector": "#env", "value": "v1"}},
                {"action": "call_api", "params": {"method": "GET", "path": "/health"}},
                {"action": "assert_response",
                 "params": {"json_path": "status", "expect": "ok"}}])

    with session_factory() as s:
        from autobugfixer.core.models import BugTicket
        task = s.get(Task, task_id)
        bug = s.get(BugTicket, task.bug_ticket_id)
        ctx = TaskContext(
            task=task, bug=bug, session=s, settings=settings, llm=RecordingLLM(),
            platform=platform, executor=None, notifier=LogNotifier(),
            audit=AuditService(s), interventions=InterventionService(s),
            env_locks=EnvLockService(s, lease_seconds=60))
        result = PlanningStage().run(ctx)
        assert result.status == "success"
        prompt = prompts[-1]
        assert "env_smoke_check(env, path)" in prompt  # 技能清单动态段
        assert "{env}" in prompt  # 模板占位符原文渲染


def test_skill_use_counted_on_structural_match(session_factory, settings, task_id, platform):
    """方案步骤与技能模板结构一致（动作序列 + 参数键集合）-> 引用计量 use_count+1。"""
    with session_factory() as s:
        service = SkillService(s)
        skill, _ = service.upsert(name="env_smoke_check", params=["env", "path"],
                                  desc="冒烟检查", template_steps=SMOKE_SKILL["steps"],
                                  source_task_id=task_id)
        s.commit()
        skill_id = skill.id

    class _LLM:
        def analyze(self, prompt, schema, *args, **kwargs):
            # 步骤与模板同构（实参已替换，键集合一致）
            return PlanOutput(steps=[
                {"action": "input", "params": {"selector": "#env", "value": "v2.0"}},
                {"action": "call_api", "params": {"method": "GET", "path": "/status"}},
                {"action": "assert_response",
                 "params": {"json_path": "status", "expect": "ok"}}])

    with session_factory() as s:
        from autobugfixer.core.models import BugTicket
        task = s.get(Task, task_id)
        bug = s.get(BugTicket, task.bug_ticket_id)
        ctx = TaskContext(
            task=task, bug=bug, session=s, settings=settings, llm=_LLM(),
            platform=platform, executor=None, notifier=LogNotifier(),
            audit=AuditService(s), interventions=InterventionService(s),
            env_locks=EnvLockService(s, lease_seconds=60))
        PlanningStage().run(ctx)
        s.commit()

    with session_factory() as s:
        skill = s.get(VerificationSkill, skill_id)
        assert skill.use_count == 1
        uses = s.scalars(select(AuditLog).where(AuditLog.action == "skill_used")).all()
        assert uses and uses[0].detail["name"] == "env_smoke_check"


def test_skill_upsert_dedup_versions_on_template_change(session_factory, task_id):
    """同名技能模板变化 -> version+1 覆盖；模板相同 -> 仅追加来源任务。"""
    service = SkillService(session_factory)
    with session_factory() as s:
        s1, created = SkillService(s).upsert(name="x", params=["a"], desc="d",
                                              template_steps=SMOKE_SKILL["steps"],
                                              source_task_id=1)
        assert created
        s2, created = SkillService(s).upsert(name="x", params=["a"], desc="d",
                                              template_steps=SMOKE_SKILL["steps"],
                                              source_task_id=2)
        assert not created and s2.version == 1  # 模板未变：不升版本
        assert s2.source_task_ids == [1, 2]
        changed = json.loads(json.dumps(SMOKE_SKILL["steps"]))  # 深拷贝防共享引用
        changed[0]["params"]["selector"] = "#cluster"
        s3, created = SkillService(s).upsert(name="x", params=["a"], desc="d2",
                                             template_steps=changed, source_task_id=2)
        assert not created and s3.version == 2  # 模板演化升版本
        assert s3.desc == "d2"
        s.commit()


def test_failed_verify_does_not_distill(make_orchestrator, session_factory,
                                        settings, repo, environment):
    """验证未通过的提议不沉淀（蒸馏只发生在成功分支）。"""
    task_id = _ingest(session_factory, settings, repo, "BUG-SK2")
    failing = [
        {"complete": True, "missing": [], "suggestions": []},
        {**PLAN_WITH_PROPOSAL, "steps": [
            PLAN_WITH_PROPOSAL["steps"][0],
            PLAN_WITH_PROPOSAL["steps"][1],
            {"action": "assert_response",
             "params": {"json_path": "status", "expect": "never-match"},
             "desc": "恒失败断言"},
        ]},
    ]
    final = make_orchestrator(failing).run_until_blocked(task_id)
    assert final == TaskState.WAIT_DISCUSS
    with session_factory() as s:
        assert s.scalar(select(VerificationSkill).where(
            VerificationSkill.name == "env_smoke_check")) is None
        actions = [a.action for a in s.scalars(select(AuditLog).where(
            AuditLog.task_id == task_id)).all()]
        assert "skill_proposed" in actions
        assert "skill_distilled" not in actions
