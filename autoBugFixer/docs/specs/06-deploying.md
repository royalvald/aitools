# Spec 06 · 部署（Deploying）

| 项 | 值 |
|---|---|
| 涉及状态 | `DEPLOYING`（执行态）⇄ `WAIT_ENV`（阻塞态）；成功 → `VERIFYING` |
| 源码 | `src/autobugfixer/pipeline/stages/deploying.py`、`services/env_lock.py`、`adapters/env_executor/*` |
| 需求 | FR-REG-01（部署动作白名单）、FR-REG-02（失败自动回滚）、11.1（环境锁） |
| 上游 | AI 修复（Spec 05） |
| 下游 | 回归验证（Spec 07，共享同一临界区） |
| 环境执行器 | `local`（默认仿真）/ `ssh` / `docker`（registry 构建，凭据 Fernet 解密注入） |

## 1. 目标与职责

把修复产物安全地部署到测试环境，是**部署+验证临界区的入口**：

1. 解析目标环境与执行器；
2. 获取环境锁（拿不到则排队 `WAIT_ENV`）；
3. 部署前健康检查 → 版本快照 → 白名单部署脚本 → 产物上传 → 部署后健康检查；
4. 任一步失败自动回滚到快照、释放锁、告警；
5. 全程步骤留痕（DeployRecord.steps_log + 审计）。

## 2. 输入与前置条件

- 任务状态 `DEPLOYING`；`attempt = retry_count + 1`；
- 环境解析（`_resolve_env`）：优先 `task.environment_id` 关联的 `environment` 行，否则取库中第一条；**无环境配置 → `FAILED`**；
- 部署脚本来源：`environment.deploy_script`（声明式命令列表）；
- 修复产物：最新 `fix_record.worktree` 指向的工作区（缺失 → 异常 → `FAILED`）。

## 3. 处理流程

```
1. env 解析；task.environment_id = env.id
2. executor = resolve_executor(ctx)
   · environment.type ∈ {ssh, docker} → registry 按环境行构建
     （conn_config + CredentialVault 解密 credential_ref 注入凭据）
   · 其余（local 仿真）→ 注入的默认执行器
3. 取环境锁：ctx.env_locks.acquire(env.id, task.id)
   ├─ 失败（他人有效持有）→ 审计 env_lock_wait → success → WAIT_ENV（排队）
   └─ 成功 → 审计 env_lock_acquire，进入临界区
4. snap_tag = "task-{id}-attempt-{attempt}"；创建 DeployRecord
5. 部署序列（任一步异常 → 走 §4 失败分支）：
   a. executor.health_check() —— 部署前健康检查，不 ok 即失败
   b. executor.snapshot(snap_tag) —— 版本快照（执行器支持时）
   c. 逐条执行 env.deploy_script：
      · executor.exec(cmd) 内建白名单校验（越权直接拒绝）
      · 每条审计 cmd_exec（命令 + 返回码），steps_log 记录（stdout 截 200 字）
      · returncode != 0 → 失败
   d. 产物上传：遍历工作区（跳过 .baseline / .git）executor.upload(item, name)
   e. executor.health_check() —— 部署后健康检查
6. 全部通过：deploy.status="success" → success → VERIFYING（锁继续持有）
```

### 3.1 环境锁语义（11.1）

- 粒度：`environment_id` 互斥（DB 唯一行），**部署+验证为同一临界区**：DEPLOYING 起持锁，VERIFYING 结束释放；
- 租约：`ENV_LOCK_LEASE_SECONDS`（默认 1800s）；到期锁视为失效，调度器每轮 `reclaim_stale_env_locks()` 回收；
- 可重入：同一 task 重复 acquire 幂等成功（Stage 重入安全）；
- 释放规则：仅持锁人可释放（`release(env_id, task_id)`）。

## 4. 输出与状态迁移

| 分支 | 结果 | 迁移 | 锁 |
|---|---|---|---|
| 未取到锁 | `success` | `DEPLOYING → WAIT_ENV` | 不持有 |
| 部署成功 | `success` | `DEPLOYING → VERIFYING` | **保持持有**（临界区延续） |
| 任一步失败 | `failed` | `DEPLOYING → FAILED` | 回滚后**立即释放**（审计 reason=deploy_failed） |
| 无环境配置 | `failed` | `DEPLOYING → FAILED` | — |
| Stage 异常 | `failed`（兜底） | `→ FAILED` | Orchestrator 兜底释放 + 租约回收兜底 |

失败分支动作序列：`executor.restore(snap_tag)` 回滚 → `deploy.status="rolled_back"` → 通知 `ops`（审计 `deploy_rollback`）→ 释放锁 → `FAILED`。

### 4.1 WAIT_ENV 唤醒

迁移表 `WAIT_ENV → DEPLOYING`（锁释放后被唤醒）。当前实现由人工触发：API `POST /tasks/{id}/retry` 将 `WAIT_ENV → DEPLOYING` 后 `run_until_blocked` 重新抢锁（锁已被释放或租约到期即可成功）。

## 5. 数据模型

- 写：`deploy_record`（attempt、prev_version=snap_tag、status: pending/success/failed/rolled_back、steps_log）、`task`（environment_id、状态）、`env_lock`、`task_state_history`、`audit_log`；
- 读：`environment`、`fix_record`。

## 6. 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `ENV_LOCK_LEASE_SECONDS` | `1800` | 锁租约（防死锁） |
| `CMD_WHITELIST` | `echo/systemctl/tail` 模板 | 执行器命令白名单（FR-REG-01） |
| `ENV_ROOT` | `./var/testenv` | local 仿真环境根目录 |

## 7. 异常与失败处理

- 部署命令失败/健康检查失败/上传异常 → 统一回滚 + 释放锁 + `FAILED`（幂等可重入，人工重新触发或断点续跑）；
- 回滚本身失败（快照缺失等）：steps_log 记录 stderr，仍走失败分支并告警；
- worker 崩溃持锁泄漏 → 租约到期由调度器回收，任务重跑。

## 8. 人工介入点

无介入单。`WAIT_ENV` 排队依赖人工唤醒（或等待其他任务释放后手动 retry）；部署失败告警发给 `ops`。

## 9. 安全约束

- 命令白名单内建于 `executor.exec`（先校验后执行，越权拒绝）；`systemctl restart {service}` 等支持 `{param}` 占位模板；
- ssh/docker 凭据全程密文（Fernet），仅执行器构建时解密注入；
- 上传产物明确跳过 `.baseline/.git`，不泄漏工作区元数据。

## 10. 验收标准

- 成功路径：健康检查 → 脚本执行 → 上传 → 二次健康检查全过，`deploy_record.status=success`，任务进 `VERIFYING` 且**锁仍持有**（`tests/test_e2e.py`）；
- 脚本命令失败 → 回滚 + `deploy_record.status=rolled_back` + 通知 ops + 锁释放 + `FAILED`（`test_failure_branch.py`）；
- 环境被占 → `WAIT_ENV` + `env_lock_wait` 审计；唤醒后重入成功（`test_env_lock.py`）；
- 白名单外命令被拒绝（`test_whitelist.py`）；
- 租约过期锁被调度器回收（`test_scheduler.py`）。

## 11. 已知限制与演进

- 环境选择策略简单（无 environment_id 时取第一条），未按方案 `env_requirements` 匹配；
- 部署为同步阻塞执行，长部署需调整执行器超时；k8s 执行器为占位；
- WAIT_ENV 自动唤醒（锁释放事件驱动）为 P1 方向。
