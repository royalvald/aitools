"""完整性分析阶段（FR-PRE-02）：仓库门禁 + 规则快路径 + LLM 评估，不足则介入补充。

仓库画像补齐与 Bug x 仓库对应关系判定已移至 planning（Spec 02 §9 v3）：
本阶段只做门禁与信息质量把关，评估通过即放行 PLANNING。
"""

from __future__ import annotations

from autobugfixer.common.prompts import prompt_version, render_prompt
from autobugfixer.features.ingest.repo_check import (
    has_available_repo,
    load_bug_repos,
    repo_check_summary,
    repos_ready,
    split_repos,
    unresolved_declarations,
)
from autobugfixer.features.completeness.schemas import CompletenessEval
from autobugfixer.common.core.stage import InterventionRequest, StageResult, TaskContext
from autobugfixer.common.core.state import TaskState
from autobugfixer.common.core.bugtext import build_bug_block

REQUIRED_FIELDS = ["title", "description", "repro_steps", "expected", "actual", "env_version"]


class CompletenessStage:
    """完整性分析阶段（仓库门禁 + 规则快路径 + LLM 评估）。"""

    name = "completeness"

    def run(self, ctx: TaskContext) -> StageResult:
        """先校验关联仓库可用性，再规则快路径检查关键字段，最后 LLM 评估。"""
        bug = ctx.bug
        # 0) 仓库门禁（Spec 01 §9 B9-6 / §10）：声明的仓库须已登记且可用；
        #    未声明的 Bug 要求登记表存在可用仓库（planning 的 target_repos
        #    从登记表自动选仓）。0 次 LLM 调用（越早拦截越省成本）
        repo_rows = load_bug_repos(ctx.session, bug.id)
        declared = split_repos(bug.repo_url, bug.repo_branch)
        if declared:
            unresolved = unresolved_declarations(ctx.session, bug)
            if unresolved or not repos_ready(repo_rows):
                return self._need_repo_supplement(ctx, repo_rows, unresolved)
        elif not has_available_repo(ctx.session):
            return self._need_repo_supplement(ctx, repo_rows)
        # 1) 规则检查（快路径）：关键字段非空校验
        missing = [f for f in REQUIRED_FIELDS if not getattr(bug, f, None)]
        if missing:
            return self._need_supplement(ctx, missing, rule_based=True)
        # 2) LLM 评估：文本质量与可修复性
        system, user = render_prompt("completeness", bug_block=build_bug_block(ctx))
        result = ctx.llm.analyze(user, CompletenessEval, system=system,
                                 task_id=ctx.task.id, stage=self.name, session=ctx.session)
        assert isinstance(result, CompletenessEval)
        ctx.audit.log(action="llm_call", target=f"task:{ctx.task.id}",
                      detail={"stage": self.name, "prompt_version": prompt_version("completeness"),
                              "complete": result.complete}, task_id=ctx.task.id)
        if not result.complete:
            return self._need_supplement(ctx, result.missing, suggestions=result.suggestions)
        return StageResult(status="success", next_state=TaskState.PLANNING,
                           message="完整性评估通过")

    def _need_repo_supplement(self, ctx: TaskContext, repo_rows: list,
                              unresolved: list[dict] | None = None) -> StageResult:
        """仓库补充介入（Spec 01 §9.3 B9-6 / §10）：不拒收、不静默降级，系统主动询问。"""
        # 防死循环：仓库补充往返与信息补充共用止损上限（超限转 MANUAL）
        if ctx.task.info_rounds >= ctx.settings.max_info_rounds:
            return StageResult(status="success", next_state=TaskState.MANUAL,
                               message=f"仓库补充往返已达 {ctx.task.info_rounds} 次仍未补全，转人工")
        if unresolved:
            missing = unresolved + repo_check_summary(
                [r for r in repo_rows if r.repo.status != "available"])
        else:
            missing = repo_check_summary(repo_rows) or [
                {"path": "", "branch": "main", "status": "unavailable",
                 "reason": "未关联任何修复仓库"}]
        return StageResult(
            status="need_intervention",
            intervention=InterventionRequest(
                type="repo_supplement",
                title=f"Bug {ctx.bug.platform_bug_id} 修复仓库待补充",
                context={"missing_repos": missing, "rule_based": True},
                assignee_role="tester",
                wait_state=TaskState.WAIT_INFO,
            ),
            message="关联仓库缺失或不可用，待补充",
        )

    def _need_supplement(self, ctx: TaskContext, missing: list[str],
                         suggestions: list[str] | None = None,
                         rule_based: bool = False) -> StageResult:
        # 防死循环：补充往返超上限直接转 MANUAL（4.1.2）
        if ctx.task.info_rounds >= ctx.settings.max_info_rounds:
            return StageResult(status="success", next_state=TaskState.MANUAL,
                               message=f"信息补充往返已达 {ctx.task.info_rounds} 次仍未完整，转人工")
        return StageResult(
            status="need_intervention",
            intervention=InterventionRequest(
                type="info_supplement",
                title=f"Bug {ctx.bug.platform_bug_id} 信息待补充",
                context={"missing_fields": missing, "suggestions": suggestions or [],
                         "rule_based": rule_based},
                assignee_role="tester",
                wait_state=TaskState.WAIT_INFO,
            ),
            message=f"缺少关键信息: {missing}",
        )
