"""部署阶段（FR-REG-01/02 + 11.1 环境锁）。

环境锁从 DEPLOYING 开始持有，VERIFYING 结束释放（部署+验证为临界区）；
未取到锁则置 WAIT_ENV 挂起；任一步骤失败自动回滚并告警。

P0-3 整改：回滚语义收紧——快照能力缺失或恢复失败时显式失败并告警
（``rollback_failed`` + ``deploy_rollback_failed`` 审计 + ops 通知），
不再静默标记已回滚；SSH/Docker 执行器已实现远程快照/恢复。
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import select

from autobugfixer.common.core.models import DeployRecord, Environment, FixRecord
from autobugfixer.common.core.stage import StageResult, TaskContext
from autobugfixer.common.core.state import TaskState
from autobugfixer.common.security.redact import redact_value
from autobugfixer.adapters.env.resolve import resolve_executor

from autobugfixer.adapters.env import validate_environment


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
            env, global_whitelist=ctx.settings.cmd_whitelist,
            on_decrypt=lambda: ctx.audit.log(
                action="credential_decrypt", target=f"env:{env.id}", task_id=task.id))
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
        ctx.session.flush()
        # 取锁后即提交：环境锁行对其他进程立即可见（互斥不再依赖本事务提交时序），
        # 同时释放 SQLite 写锁，让长跑的快照/上传/远程命令期间认领心跳可续约（P0-4）
        ctx.session.commit()

        try:
            # 部署前健康检查前置（PRD 风险应对）
            health = executor.health_check()
            if not health.ok:
                raise RuntimeError(f"环境健康检查失败: {health.detail}")

            # 记录当前版本快照（供回滚）；执行器无快照能力时显式留痕告警
            # （P0-3：无快照则部署失败后无从回滚，不允许静默继续当作可回滚）
            if hasattr(executor, "snapshot"):
                executor.snapshot(snap_tag)  # type: ignore[attr-defined]
            else:
                ctx.audit.log(action="env_snapshot_unsupported", target=f"env:{env.id}",
                              detail={"task_id": task.id, "executor": type(executor).__name__},
                              task_id=task.id)
                ctx.notifier.send("ops", _notice(
                    f"任务 {task.id} 所用执行器 {type(executor).__name__} 无快照能力，"
                    "部署失败将无法自动回滚", {"env": env.name}))

            # 声明式部署脚本（白名单命令）
            for cmd in env.deploy_script:
                result = executor.exec(cmd)
                ctx.audit.log(action="cmd_exec", target=f"env:{env.id}",
                              detail={"cmd": cmd, "returncode": result.returncode},
                              task_id=task.id)
                # stdout 可能携带凭据回显（P0-6）：落库前脱敏
                steps_log.append(redact_value(
                    {"cmd": cmd, "returncode": result.returncode,
                     "stdout": result.stdout[:200]}))
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
            # 任一步骤失败 -> 尝试回滚至修复前版本；回滚失败/能力缺失显式告警
            # （FR-REG-02 规则 + P0-3：不得静默标记已回滚）
            rollback_ok, rollback_reason = self._rollback(ctx, env, snap_tag,
                                                          steps_log, executor)
            deploy.status = "rolled_back" if rollback_ok else "rollback_failed"
            deploy.steps_log = steps_log
            ctx.session.flush()
            self._release_lock(ctx, task)  # 部署失败立即释放环境锁（11.1）
            message = ("部署失败已回滚" if rollback_ok
                       else f"部署失败且回滚失败（环境可能处于中间态，需人工介入）: "
                            f"{rollback_reason}") + f": {exc}"
            return StageResult(status="failed", next_state=TaskState.FAILED,
                               message=message)

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
            FixRecord.task_id == ctx.task.id).order_by(FixRecord.id.desc()))
        if record is None:
            raise RuntimeError("缺少修复记录，无法部署")
        return Path(record.worktree)

    def _rollback(self, ctx: TaskContext, env: Environment, snap_tag: str,
                  steps_log: list[dict], executor) -> tuple[bool, str]:
        """尝试回滚到部署前快照，返回 (是否回滚成功, 失败原因)。

        P0-3：回滚能力缺失（执行器无 restore）或恢复失败时，显式审计
        ``deploy_rollback_failed`` 并向 ops 告警——环境实际未回滚，绝不能
        留痕为已回滚（此前假回滚会让中间态环境被当作干净基线复用）。
        """
        if not hasattr(executor, "restore"):
            reason = (f"执行器 {type(executor).__name__} 不支持远程恢复，"
                      "环境停留在部署中间态")
            ctx.audit.log(action="deploy_rollback_failed", target=f"env:{env.id}",
                          detail={"snapshot": snap_tag, "reason": reason},
                          task_id=ctx.task.id)
            ctx.notifier.send("ops", _notice(
                f"任务 {ctx.task.id} 部署失败且无法回滚（环境中间态，需人工处理）",
                {"env": env.name, "snapshot": snap_tag, "reason": reason}))
            return False, reason
        try:
            executor.restore(snap_tag)  # type: ignore[attr-defined]
            steps_log.append({"cmd": f"rollback to {snap_tag}", "returncode": 0})
        except Exception as exc:
            reason = f"恢复快照失败: {exc}"
            steps_log.append({"cmd": f"rollback to {snap_tag}", "returncode": 1,
                              "stderr": str(exc)})
            ctx.audit.log(action="deploy_rollback_failed", target=f"env:{env.id}",
                          detail={"snapshot": snap_tag, "reason": reason},
                          task_id=ctx.task.id)
            ctx.notifier.send("ops", _notice(
                f"任务 {ctx.task.id} 部署失败且回滚失败（环境中间态，需人工处理）",
                {"env": env.name, "snapshot": snap_tag, "reason": reason}))
            return False, reason
        ctx.audit.log(action="deploy_rollback", target=f"env:{env.id}",
                      detail={"snapshot": snap_tag}, task_id=ctx.task.id)
        ctx.notifier.send("ops", _notice(f"任务 {ctx.task.id} 部署失败已回滚",
                                         {"env": env.name, "snapshot": snap_tag}))
        return True, ""


def _notice(title: str, detail: dict):
    from autobugfixer.features.intervention.notifier import NoticeMessage

    return NoticeMessage(title=title, content=str(detail)[:500])
