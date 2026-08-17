# Spec 06 · 部署（Deploying）

| 项 | 值 |
|---|---|
| 涉及状态 | `DEPLOYING`（执行态）⇄ `WAIT_ENV`（阻塞态）；出口 `{VERIFYING, WAIT_ENV, FAILED}` |
| 源码 | `pipeline/stages/deploying.py`、`services/env_lock.py`、`adapters/env_executor.py`（local）、`adapters/env_executor/{ssh_executor,docker_executor}.py`、`adapters/whitelist.py`、`services/writeback.py` |
| 需求 | FR-REG-01（部署白名单）、FR-REG-02（失败自动回滚）、11.1（环境锁） |
| 上游 / 下游 | AI 修复（Spec 05）→ 回归验证（Spec 07，共享同一临界区） |

## 1. 目标

把修复产物安全部署到测试环境，是**部署+验证临界区的入口**：拿环境锁 → 健康检查 → 快照 → 白名单脚本 → 上传产物 → 健康检查 → 交验证；任一步失败回滚+释放锁+告警。本 spec 以**部署全过程时序**为主线（§2），锁/执行器/白名单/回滚四套内部机制在后。

| # | 预期 | 验证方式 |
|---|---|---|
| R1 | 环境互斥：同一 environment 同时只有一个任务在临界区内（DB 行锁 + 租约） | `env_lock` 表 UNIQUE(env_id) + 审计 |
| R2 | 部署命令全部过白名单，越权命令在执行前被拒 | `CommandRejectedError` + cmd_exec 审计 |
| R3 | 任一步失败：回滚至快照（执行器支持时）→ `rolled_back` 留痕 → ops 告警 → 锁释放 → `FAILED` | DeployRecord.steps_log + 审计链 |
| R4 | 拿不到锁不失败：排队 `WAIT_ENV`，人工唤醒后重入 | `env_lock_wait` 审计 + 状态历史 |
| R5 | 全部步骤留痕（steps_log 逐条 cmd/returncode/stdout） | DeployRecord.steps_log |

## 2. 部署全过程时序（主线）

```
IN  task.state=DEPLOYING（attempt = retry_count + 1，snap_tag = task-{id}-attempt-{n}）

S1 环境解析        deploying.py:27,101-105
   task.environment_id 有值 → session.get(Environment)；无值 → 库中第一条 Environment
   ├─ 无环境行 → OUT-4 FAILED（"无可用测试环境配置"，未取锁）
   └─ 成功 → 回写 task.environment_id

S2 执行器解析      common.py:200-215（配置消费与缺配行为见 §2.1）
   env.type ∈ {ssh, docker} → registry 构建（ssh 附带 Fernet 凭据解密）
   其余（local 等）→ Orchestrator 注入的默认执行器

S3 取环境锁        deploying.py:35-41（算法见 §3）
   ├─ False（他人有效持有）→ 审计 env_lock_wait → OUT-1 WAIT_ENV
   └─ True（含重入/过期回收后新取）→ 审计 env_lock_acquire → 进临界区

S4 建 DeployRecord（attempt、prev_version=snap_tag，status 待定）

S5 部署前健康检查   executor.health_check()（三实现见 §4）
   not ok → 抛 RuntimeError → F 失败分支

S6 版本快照        hasattr(executor, "snapshot") 才执行（§4 能力矩阵）
   Local：整目录拷贝至 {env_root.parent}/{env名}.snapshots/{snap_tag}/
   SSH/Docker：无此方法 → 静默跳过（后续失败将无快照可还原，见 §6）

S7 逐条执行部署脚本  for cmd in env.deploy_script:
     executor.exec(cmd)（白名单断言 → 执行，§5）
     审计 cmd_exec(cmd, returncode)；steps_log += {cmd, returncode, stdout[:200]}
     returncode≠0 → RuntimeError(含 stderr) → F
   （注意：失败命令的 stderr 只进异常消息，steps_log 无该条记录）

S8 产物上传        deploying.py:71-76
   workspace = 最新 attempt 的 FixRecord.worktree（无 FixRecord → RuntimeError → F）
   for item in sorted(workspace.iterdir())，跳过 .baseline / .git：
     executor.upload(item, item.name)（三实现见 §4；任一异常 → F，此步失败不写 steps_log 条目）
   steps_log += {"cmd": "upload <ws>", "returncode": 0}

S9 部署后健康检查   not ok → RuntimeError → F

F  失败分支（S5-S9 任一异常）deploying.py:82-90
   1) _rollback（§6）：有 restore 能力则还原；审计 deploy_rollback；notify ops（content=detail[:500]）
   2) deploy.status="rolled_back"；steps_log 落库
   3) _release_lock：release() 返回 True 才审计 env_lock_release(reason=deploy_failed)
   → OUT-2 FAILED

E  Stage 级异常兜底  orchestrator.py:185-204
   审计 stage_exception → 尝试释放锁（成功审计 env_lock_release_on_error）→ FAILED

出口：
OUT-1 WAIT_ENV（锁被占，S3）→ 人工 POST /tasks/{id}/retry → WAIT_ENV→DEPLOYING（routes.py:103-107）→ 回 S3 重抢
OUT-2 FAILED（失败已回滚，锁已释放）→ retry 时 FAILED→ANALYZING（回分析重跑整链，不是回 DEPLOYING）
OUT-3 VERIFYING（S5-S9 全过）：deploy.status="success"；**锁保持持有**，由 Spec 07 的 finally 释放
OUT-4 FAILED（无环境行，未取锁）
进程崩溃残留锁 → 租约 1800s 过期 → 调度器每轮 reclaim（§3.3）
```

### 2.1 环境配置的解析与检查（as-built：无显式预检，靠运行期失败暴露 + 三个静默陷阱）

`environment` 行七字段在部署链路的消费点与缺配行为——**代码没有任何配置预检步骤**，问题要么运行期炸出（→ FAILED），要么静默通过：

| 字段 | 消费点 | 缺失/非法时 as-built 行为 |
|---|---|---|
| `type` | resolve_executor（common.py:210-212） | 只认 `ssh`/`docker` 走 registry；**其他任何值（拼错 "ssh2"、预留 "k8s"、空串）一律落默认 local 执行器，无任何告警——陷阱 ①** |
| `conn_config` | ssh：from_env_model 取 host/port/workdir/health_cmd（ssh_executor.py:78）；docker：取 container/workdir/health_cmd/base_url | ssh 缺 `host` → `cls(**cfg)` TypeError → S2 异常 → Stage 兜底 FAILED；**local 类型完全忽略该字段**（env_root 来自全局 `settings.env_root`，启动点构造：cli.py:73 / api/app.py:65 / scheduler_cli.py:30） |
| `credential_ref` | 仅 ssh：Fernet 解密 JSON（username/password 或 key_filename）合并连接参数 | 解密失败/密文损坏 → S2 异常 FAILED；**空串 = 不注入凭据**（paramiko 回退系统 ~/.ssh 与当前用户）；local/docker 忽略 |
| `cmd_whitelist` | ssh/docker 经 registry 注入执行器（registry.py:83-86） | **对 local 无效**——local 执行器白名单取全局 `settings.cmd_whitelist`（启动点构造），环境行配了也不生效——陷阱 ② |
| `deploy_script` | S7 逐条执行 | **空列表 = 零条命令静默通过**（部署"成功"），只剩健康检查兜底——陷阱 ③；首条命令不命中白名单 → S7 CommandRejectedError → 失败分支（运行期才暴露） |
| `name` | DB 层唯一约束 | 重复插入直接 DB 报错 |
| （local）env_root | LocalExecutor 构造时 `mkdir(parents=True, exist_ok=True)`（env_executor.py:72） | **目录自动创建**——S5/S9 健康检查对 local 是存在性弱检查，基本恒过 |

**P1 目标预检规则（待实现）**：环境配置录入或部署前显式校验——① `type` 枚举（local/ssh/docker，k8s 明确拒绝）；② ssh 必填 `host` 且 `credential_ref` 可解密；③ docker 必填 `container`；④ `deploy_script` 非空且**逐条命中该环境生效的白名单**（把"必败配置"提前到部署前暴露）；⑤ local 类型提示 `conn_config`/`cmd_whitelist` 字段不生效。

## 3. 环境锁机制（DB 行实现，带租约）

### 3.1 acquire 算法（env_lock.py:36-56）

1. 查 env_lock 行（互斥靠 `env_id` UNIQUE 约束）；
2. 行存在且 `holder_task_id == task_id` → **True（重入幂等）**；
3. 行存在且未过期（他人有效持有）→ False；
4. 行存在且已过期 → delete + flush 后走插入；
5. 插入新行（`expires_at = now + lease_seconds`）→ True；并发冲突（IntegrityError）→ rollback → False。

### 3.2 租约与续期

- 默认 `lease_seconds=1800`（配置 `env_lock_lease_seconds`，30 分钟）；
- `renew(env_id, task_id)`：仅持锁人可续，续一个租约周期——**全流水线无任何调用点**（仅测试覆盖），即长临界区不做续期，超过 30 分钟的部署+验证可能被回收重入。

### 3.3 回收与四个释放时机

- 过期批量回收：`release_expired()` 遍历全部锁删过期行；调度器每轮 `run_round` 调用（scheduler.py:58）。
- 释放时机对比（各自的审计动作名不同）：

| 时机 | 位置 | 审计动作 |
|---|---|---|
| 部署失败 | deploying.py:107-115 | `env_lock_release`（detail.reason=**deploy_failed**） |
| 验证收口（正常/重试/异常 finally） | verifying.py:77-82 | `env_lock_release`（无 reason） |
| Orchestrator 兜底 | orchestrator.py:185-204 | `env_lock_release_on_error`（独立动作名） |
| 租约过期回收 | env_lock.py:76-85 | 无逐锁审计（调度器计数 locks_reclaimed） |

## 4. 执行器体系

### 4.1 分派规则（common.py:200-215）

仅 `env.type ∈ {ssh, docker}` 走 registry 构建（ssh 附 `CredentialVault(fernet_key)` 解密 `credential_ref`，明文凭据仅驻内存、不进异常文本）；**local 等其余类型一律用注入的默认执行器**（不经 registry）。

### 4.2 三执行器关键差异

| 能力 | LocalExecutor | SSHExecutor | DockerExecutor |
|---|---|---|---|
| exec | 白名单→shlex.split（不经 shell）→ `argv[0]=="echo"` 走**内建仿真**（不执行进程直接回显）→ 其余 `subprocess.run(cwd=env_root, timeout=60)`；FileNotFoundError→127 | 白名单断言**先于连接**；workdir≠"/" 时包成 `cd {shlex.quote(workdir)} && {cmd}`；exec_command 超时 60s、连接超时 10s；paramiko 惰性导入 | 白名单断言后容器内 `["/bin/sh","-c",cmd]` + workdir + demux；SDK 惰性导入（缺包抛 RuntimeError 带安装提示）；exec_timeout 参数当前**未传入 exec_run**（不生效） |
| upload | 目录 rmtree+copytree 整体替换 / 文件 copy2 | SFTP 递归 rglob 逐文件 put，逐级建目录 | 打成内存 tar 后 put_archive |
| snapshot/restore | 有（§6） | **无** | **无** |
| health_check | env_root 目录存在即 ok | 配了 health_cmd 则执行（同样过白名单），否则仅测连通；连接失败返回 ok=False 而非异常 | container.reload() 后 status=="running"，可选 health_cmd |
| query_db | 有（DSL 数据类动作用） | **抛 NotImplementedError** | **抛 NotImplementedError** |

## 5. 命令白名单（whitelist.py，三重拦截）

1. **模板编译**：模板 shlex.split 后，`{x}` 占位 → `(\S+)`，其余段 re.escape，段间 `\s+`，整条锚定匹配；
2. **元字符黑名单**：命令含 `[;&\|`$<>\n]` 任一字符直接拒（防拼接注入/命令替换/管道重定向）；
3. **参数字符集**：占位符捕获的每个参数须匹配 `^[\w./:=@+-]+$`。

拒绝抛 `CommandRejectedError`（PermissionError 子类）→ Stage 异常 → 失败分支。默认白名单 5 条模板：`echo {text}`、`systemctl start/stop/restart {service}`、`tail -n {n} {log}`（config.py:50-58）。真实拦截用例见 `tests/test_whitelist.py`（`echo ok; rm -rf /`、`echo $(whoami)`、重定向等 11 个拒绝样例）。

## 6. 回滚机制

- **快照内容**：部署前 env_root 整目录递归拷贝到 `{env_root.parent}/{env名}.snapshots/{snap_tag}/`，tag 已存在先 rmtree；
- **还原算法**（LocalExecutor.restore）：清空 env_root 全部内容后从快照目录全量拷回；快照不存在抛 FileNotFoundError（由失败分支捕获记 steps_log stderr）；
- **两级降级（as-built 关键事实）**：
  1. 执行器无 snapshot/restore 方法（**ssh/docker 均如此**）→ 部署时不做快照、失败时不还原——远程环境停留在半部署状态，仅 ops 告警 + 审计，**无报错**；
  2. 有能力但快照缺失 → restore 抛错记 steps_log，回滚链其余步骤（告警/审计/释放锁/FAILED）照常。
- 回滚后 steps_log 追加 `rollback to {snap_tag}` 条目，审计 `deploy_rollback`（detail 含 snapshot tag）。

## 7. 异常矩阵

| 场景 | 行为 | 结果 |
|---|---|---|
| 无环境配置行 | S1 判空 | FAILED（未取锁） |
| 环境被他人持有 | S3 acquire False | WAIT_ENV（审计 env_lock_wait），不失败 |
| 健康检查不过（前/后） | RuntimeError | 失败分支：回滚+释放锁 → FAILED |
| 白名单外命令 | CommandRejectedError（执行前） | 失败分支 → FAILED |
| 部署命令退出码非 0 | RuntimeError（含 stderr） | 同上；stderr 不进 steps_log |
| 上传异常 | 直接进失败分支 | 同上；此步失败无 steps_log 条目 |
| 缺 FixRecord（无工作区） | S8 RuntimeError | 同上 |
| 进程崩溃 | 残留锁等租约过期 | 调度器下轮回收 |

## 8. 数据与配置（真实字段名，环境变量加 `AUTOBUGFIXER_` 前缀）

- `environment` 表：type（local/ssh/docker）、deploy_script（JSON 命令列表）、cmd_whitelist、credential_ref（Fernet 密文）；
- `env_lock` 表：env_id（UNIQUE）、holder_task_id、expires_at；
- `deploy_record` 表：attempt、prev_version（=snap_tag）、status（**代码只写 "success"/"rolled_back" 两种值**，模型注释里的 "failed" 无写入点）、steps_log（JSON）；
- 配置：`env_lock_lease_seconds=1800`、`env_root=./var/testenv`、`cmd_whitelist`（5 条默认模板）、`workspace_root`。

## 9. 测试映射（含旧版错引修正）

| 条款 | 测试 | 备注 |
|---|---|---|
| 全链路部署+锁获取/释放+cmd_exec 审计 | `test_end_to_end_full_pipeline` | 断言审计动作集合与 CLOSED，**未直接查 DeployRecord** |
| 失败回滚+锁释放（deploy_script=["false"]） | `test_env_lock.py::test_部署失败释放锁` | 断言 FAILED + EnvLock 空 + 环境可被他人立即获取；**未断言 rolled_back 与 ops 通知** |
| 锁互斥/租约过期/过期回收/renew | `test_env_lock.py` 六用例 | — |
| 白名单拦截 | `test_whitelist.py` | — |
| SSH/Docker 执行器（拒绝先于连接、cd 包装、凭据解密、tar 上传、容器健康） | `test_adapters_real.py` | — |
| WAIT_ENV 排队 + env_lock_wait 审计 | **无覆盖** | 旧版引 test_env_lock.py 为**虚构**（该文件无 WAIT_ENV 用例） |
| 调度器回收过期锁 | **无覆盖**（仅 service 层直接调用有测试） | 旧版引 test_scheduler.py 为**虚构**（全文无锁断言） |
| rolled_back 状态 + ops 通知 | **无覆盖** | 旧版引 test_failure_branch.py 为**错引**（该文件测讨论介入，零部署断言） |

## 10. 已知限制

- **环境配置零预检**：三个静默陷阱（type 拼错静默降级 local / local 忽略 conn_config 与 cmd_whitelist / 空 deploy_script 零步通过）见 §2.1，P1 预检规则待实现；
- **ssh/docker 无回滚能力**：失败后远程环境停留在半部署状态（§6 两级降级第一条）——生产启用远程执行器前必须补远程快照方案；
- `renew` 未接线：超 30 分钟的临界区锁会被回收，存在双任务同环境风险；
- 无 environment_id 时取库中第一条环境（多环境时选择不可控）；
- Docker `exec_timeout` 参数未传入 exec_run（不生效）；
- steps_log 失败命令无独立条目（stderr 只在异常消息里）、上传失败无条目；
- k8s 执行器仅枚举预留，代码完全不存在。
