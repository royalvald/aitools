"""部署阶段（FR-REG-01/02 + 11.1 环境锁）。

环境锁从 DEPLOYING 开始持有，VERIFYING 结束释放（部署+验证为临界区）；
未取到锁则置 WAIT_ENV 挂起；任一步骤失败自动回滚并告警。
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import select

from ...models import DeployRecord, Environment, FixRecord
from ..stage import StageResult, TaskContext
from ..state import TaskState
from .common import resolve_executor

from ...adapters.env_executor import validate_environment


class DeployingStage:
    """部署阶段（环境锁临界区 + 声明式部署 + 失败回滚）。"""

    name = "deploying"

    def run(self, ctx: TaskContext) -> StageResult:
        """取环境锁后执行部署脚本与产物更新，失败自动回滚；成功进入验证。"""
        task = ctx.task
        env = self._resolve_env(ctx)
        if env is None:
            return StageResult(status="failed", next_state=TaskState.FAILED,
                               message="无可用测试环境配置")
        task.environment_id = env.id

        # 环境配置预检（Spec 06 §2.1 P1）：必败配置在取锁前暴露，不再静默降级/零步通过
        errors, warnings = validate_environment(
            env, global_whitelist=ctx.settings.cmd_whitelist)
        for warning in warnings:
            ctx.audit.log(action="env_config_warning", target=f"env:{env.id}",
                          detail={"warning": warning}, task_id=task.id)
        if errors:
            ctx.audit.log(action="env_config_rejected", target=f"env:{env.id}",
                          detail={"errors": errors}, task_id=task.id)
            return StageResult(status="failed", next_state=TaskState.FAILED,
                               message=f"环境配置预检失败: {'; '.join(errors)}")

        executor = resolve_executor(ctx)  # ssh/docker 走 registry 构建

        # 11.1：进入临界区前取环境锁，未取到则挂起排队
        if not ctx.env_locks.acquire(env.id, task.id):
            ctx.audit.log(action="env_lock_wait", target=f"env:{env.id}",
                          detail={"task_id": task.id}, task_id=task.id)
            return StageResult(status="success", next_state=TaskState.WAIT_ENV,
                               message=f"环境 {env.name} 被占用，排队等待")
        ctx.audit.log(action="env_lock_acquire", target=f"env:{env.id}",
                      detail={"task_id": task.id}, task_id=task.id)

        attempt = ctx.attempt
        snap_tag = f"task-{task.id}-attempt-{attempt}"
        steps_log: list[dict] = []
        deploy = DeployRecord(task_id=task.id, attempt=attempt, prev_version=snap_tag)
        ctx.session.add(deploy)

        try:
            # 部署前健康检查前置（PRD 风险应对）
            health = executor.health_check()
            if not health.ok:
                raise RuntimeError(f"环境健康检查失败: {health.detail}")

            # 记录当前版本快照（供回滚）
            if hasattr(executor, "snapshot"):
                executor.snapshot(snap_tag)  # type: ignore[attr-defined]

            # 声明式部署脚本（白名单命令）
            for cmd in env.deploy_script:
                result = executor.exec(cmd)
                ctx.audit.log(action="cmd_exec", target=f"env:{env.id}",
                              detail={"cmd": cmd, "returncode": result.returncode},
                              task_id=task.id)
                steps_log.append({"cmd": cmd, "returncode": result.returncode,
                                  "stdout": result.stdout[:200]})
                if not result.ok:
                    raise RuntimeError(f"部署命令失败: {cmd} -> {result.stderr}")

            # 将修复后的工作区产物更新至环境（跳过基线快照与 git 元数据）
            workspace = self._workspace(ctx)
            for item in sorted(workspace.iterdir()):
                if item.name in (".baseline", ".git"):
                    continue
                executor.upload(item, item.name)
            steps_log.append({"cmd": f"upload {workspace}", "returncode": 0})

            # 部署后健康检查
            health = executor.health_check()
            if not health.ok:
                raise RuntimeError(f"部署后健康检查失败: {health.detail}")
        except Exception as exc:
            # 任一步骤失败 -> 自动回滚至修复前版本并告警（FR-REG-02 规则）
            self._rollback(ctx, env, snap_tag, steps_log, executor)
            deploy.status = "rolled_back"
            deploy.steps_log = steps_log
            ctx.session.flush()
            self._release_lock(ctx, task)  # 部署失败立即释放环境锁（11.1）
            return StageResult(status="failed", next_state=TaskState.FAILED,
                               message=f"部署失败已回滚: {exc}")

        deploy.status = "success"
        deploy.steps_log = steps_log
        ctx.session.flush()
        return StageResult(status="success", next_state=TaskState.VERIFYING,
                           artifacts={"deploy_record_id": deploy.id},
                           message="部署完成，进入验证")

    # ---- 内部 ----

    @staticmethod
    def _resolve_env(ctx: TaskContext) -> Environment | None:
        if ctx.task.environment_id:
            return ctx.session.get(Environment, ctx.task.environment_id)
        return ctx.session.scalar(select(Environment).limit(1))

    @staticmethod
    def _release_lock(ctx: TaskContext, task) -> None:
        """释放任务持有的环境锁（幂等；仅在实际释放成功时留痕）。"""
        if task.environment_id is None:
            return
        if ctx.env_locks.release(task.environment_id, task.id):
            ctx.audit.log(action="env_lock_release", target=f"env:{task.environment_id}",
                          detail={"task_id": task.id, "reason": "deploy_failed"},
                          task_id=task.id)

    @staticmethod
    def _workspace(ctx: TaskContext) -> Path:
        record = ctx.session.scalar(select(FixRecord).where(
            FixRecord.task_id == ctx.task.id).order_by(FixRecord.attempt.desc()))
        if record is None:
            raise RuntimeError("缺少修复记录，无法部署")
        return Path(record.worktree)

    def _rollback(self, ctx: TaskContext, env: Environment, snap_tag: str,
                  steps_log: list[dict], executor) -> None:
        if hasattr(executor, "restore"):
            try:
                executor.restore(snap_tag)  # type: ignore[attr-defined]
                steps_log.append({"cmd": f"rollback to {snap_tag}", "returncode": 0})
            except Exception as exc:
                steps_log.append({"cmd": "rollback", "returncode": 1, "stderr": str(exc)})
        ctx.audit.log(action="deploy_rollback", target=f"env:{env.id}",
                      detail={"snapshot": snap_tag}, task_id=ctx.task.id)
        ctx.notifier.send("ops", _notice(f"任务 {ctx.task.id} 部署失败已回滚",
                                         {"env": env.name, "snapshot": snap_tag}))


def _notice(title: str, detail: dict):
    from ...adapters.notifier import NoticeMessage

    return NoticeMessage(title=title, content=str(detail)[:500])
