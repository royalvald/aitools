# Spec 07 · 回归验证（Verifying）

| 项 | 值 |
|---|---|
| 涉及状态 | `VERIFYING`（执行态）；出口 `{LEARNING, FIXING, FAILED}` |
| 源码 | `pipeline/stages/verifying.py`、`pipeline/dsl.py::DSLInterpreter`、`pipeline/stages/common.py::resolve_executor` |
| 需求 | FR-REG-03（回归验证与证据链）、FR-FIX-02（感知对比）、11.1（临界区收尾）、11.4（DSL）、11.5（重试反馈） |
| 上游 / 下游 | 部署（Spec 06，锁已持有，OUT-3 交接到本阶段）→ 经验沉淀（Spec 08）或回 AI 修复（Spec 05 重试环） |
| 消费产物 | 最新版本 `verification_plan`（Spec 03 产出，可能经人工确认 version+1，见 services/intervention.py:110-123） |

## 1. 目标

对部署产物按验证方案**逐条解释执行 DSL 步骤**，产出结论与证据链，驱动重试环，并作为**部署+验证临界区的收口**释放环境锁。本 spec 以**验证执行全过程时序**为主线（§2），DSL 执行语义、运行时上下文、重试环、感知对比、锁释放五套机制在后。

| # | 预期 | 验证方式 |
|---|---|---|
| R1 | 每次验证恰好 1 条 `VerifyRecord`（conclusion / step_results / risk_notes / plan_version / attempt），通过失败一律留痕 | `verify_record` 表 + 审计 `verify` |
| R2 | 逐步骤留证据摘要（页面片段/响应体/行数据/日志，截 200 字），单步失败不中断后续步骤 | step_results[].evidence |
| R3 | 全过 → `LEARNING`；未过且未达上限 → 回 `FIXING` 且 `retry_count+1`；耗尽 → `LEARNING` 失败分支（Spec 08） | 状态历史 + retry 分支代码路径 |
| R4 | 任何出口（通过/重试/耗尽/方案缺失/异常）都不泄漏环境锁 | `env_lock` 表清空 + 审计 `env_lock_release` |
| R5 | 感知对比（开关开时）新增异常进 `risk_notes` 前 10 条，且**不影响 conclusion**，感知失败不阻断 | `test_api_fields_perception.py` |

## 2. 验证执行全过程时序（主线）

```
IN  task.state=VERIFYING（部署 OUT-3 进入；同一环境行 + 环境锁仍持有 + 修复产物已在环境内，
    交接细节见 §3.1）

S1 取最新版方案     verifying.py:30-34
   select(VerificationPlan).where(task_id).order_by(version.desc()) 取第一条
   ├─ 无方案行 → StageResult(failed) → OUT-3 FAILED（"缺少验证方案"，finally 仍释放锁）
   └─ 有 → 即为本次执行版本（plan_version 落库到 VerifyRecord）

S2 解析执行器      verifying.py:36 → common.py:200-215
   与部署阶段同一逻辑：env.type ∈ {ssh, docker} → registry 构建（ssh 附 Fernet 解密）；
   local 等 → Orchestrator 注入的默认 LocalExecutor
   （远程执行器无 query_db，数据类动作不可用，见 §3.4 / Spec 06 §4.2）

S3 DSL 逐条执行    verifying.py:37-38 → dsl.py:105-111
   for step in plan.steps: dict → DSLStep.model_validate（词表+必填参数校验）
   → _run_step 分发到 _do_<action>，异常捕获为该步 passed=False（不中断）
   （语义明细见 §3；注意：model_validate 的校验错误在逐步捕获**之外**，
    会炸出整条链路 → Stage 异常 → OUT-4）

S4 通过判定        verifying.py:39
   passed = all(r.passed for r in results)   ← 空步骤列表空真通过（0 步全过）

S5 感知对比（可选） verifying.py:46 → _capture_post_fix（§5）
   perception_enabled 且 perception 已注入时：capture("post_fix") + load_snapshot("pre_fix")
   + compare；introduced 前 10 条 → risk_notes；任何异常仅 warning，risk_notes 置空

S6 VerifyRecord 落库 + 审计  verifying.py:48-58
   {task_id, attempt=ctx.attempt（=retry_count+1, stage.py:72-75）,
    plan_version=plan.version, conclusion="passed"/"failed",
    step_results=[{action,passed,detail,evidence}...], risk_notes}
   审计 verify（detail: conclusion / plan_version / risk_notes 有无）

S7 三路分流        verifying.py:60-76
   ├─ passed → status=success → OUT-1 LEARNING（成功分支，artifacts: verify_record_id）
   ├─ 未过且 task.retry_count < task.max_retry → status=retry
   │   → OUT-2 FIXING（artifacts: verify_record_id + failed_steps；
   │     retry_count 由 Orchestrator 处理 retry 时 +1，orchestrator.py:153-157）
   └─ 未过且已达上限 → status=success → OUT-1' LEARNING（**失败分支**，
       message="重试 N 次仍未通过"，同样携带 failed_steps，Spec 08 据此建讨论介入）

S8 finally 释放锁  verifying.py:77-82（§6）
   task.environment_id 非空 → env_locks.release(env_id, task_id)
   → 返回 True 才审计 env_lock_release（detail 仅 task_id，无 reason 字段——
     区别于部署失败的 reason=deploy_failed，Spec 06 §3.3）

出口：
OUT-1  LEARNING 成功分支（conclusion=passed）
OUT-2  FIXING（重试环起点，见 §4；回修复后重走 DEPLOYING 再进 VERIFYING）
OUT-1' LEARNING 失败分支（conclusion=failed，重试耗尽）
OUT-3  FAILED（方案缺失；锁已在 finally 释放）
OUT-4  FAILED（Stage 异常，如 DSLStep 校验错；锁先被 finally 释放，
       Orchestrator 兜底再 release 返回 False、不再审计，orchestrator.py:185-204）
```

## 3. DSL 执行语义（dsl.py 逐动作 as-built）

### 3.1 环境复用与仿真文件映射（验证的就是部署产物）

**与 Spec 06 的三项交接（本阶段不重建环境，直接复用）**：

1. **同一环境行**：部署 S1 把 `task.environment_id` 写库（deploying.py:31）；验证 S2 用**同一行**解析执行器（verifying.py:36 → common.py:200-215）——local 得到同一个 `env_root` 目录、ssh 连同一主机同一 `workdir`、docker 进同一容器；
2. **环境锁不重取**：临界区从部署 S3 取锁开始持续持有，验证阶段**不再 acquire**，用完在 finally 释放（§6）；重试环回 FIXING→DEPLOYING 时因锁已释放而重新走取锁流程；
3. **被测对象 = 部署产物，不是修复工作区**：验证阶段读的文件就是部署 S8 上传进环境的内容。完整链条（BUG-T001）：

```
修复 agent 写 workspace/api/health.json（fail→ok，Spec 05 §2.4）
  → 部署 S8 upload → env_root/api/health.json（Spec 06 §2 S8）
  → 验证 call_api GET /health → DSL 映射读 api/health.json（下表）→ 断言 status==ok
```

即"验证通过的"是"部署到环境里的"——部署漏传/传错文件会直接表现为对应步骤失败，这正是部署与验证构成同一临界区的原因。远程环境同理：部署 S8 上传到远程 `workdir`，`read_text` 经 SFTP（ssh_executor.py:151）/容器（docker_executor.py:132）读同一目录树。

`DSLInterpreter(executor)` 只依赖 `DSLRuntime` 协议两个能力：`read_text(rel_path)` 与 `query_db(sql)`（dsl.py:69-78），由环境执行器提供。LocalExecutor 以 `env_root` 目录仿真被测系统（env_executor.py:67-89,172-182）：

| 动作 | 仿真映射 |
|---|---|
| `open_page url` | 读 `pages/{url 去首斜杠、/ 替换为 _}.html`（dsl.py:125） |
| `call_api path` | 读 `api/{path 同规则}.json`（dsl.py:156） |
| `check_log service` | 读 `logs/{service}.log`（dsl.py:215） |
| `query_db / assert_db` | 走 `executor.query_db`（LocalExecutor 执行 env_root 下 `app.db` 的 SQLite，dsl.py:189 / env_executor.py:172-182） |

文件不存在 → read_text 返回 None → 该步失败（"页面不存在/接口无响应/日志不存在"）。

### 3.2 隐式状态槽位 `_last_page` / `_last_response`

解释器内部两个槽位实现步骤间传递（初始 `""` / `None`，dsl.py:102-103）：

- `_last_page`（str）：`open_page` 成功后写入；`assert_element` 对它断言；
- `_last_response`（Any）：`call_api`（json.loads，解析失败存 `{"_raw": content}`）与 **`query_db`（行列表，dsl.py:190）共用同一槽位**——先 `query_db` 再 `assert_response`，断言对象是行列表而非接口响应，这是方案编写时必须避开的坑。

### 3.3 九动作语义明细

| 动作 | 语义 | 关键 as-built 事实 |
|---|---|---|
| `open_page url` | 读仿真页面入 `_last_page` | url 是映射键不是 URL，`/order` → `pages/order.html` |
| `click selector` | 恒过 | 本地仿真不驱动浏览器（dsl.py:132-134），仅 detail 记录 |
| `input selector value` | 恒过 | 同上（dsl.py:136-137） |
| `assert_element selector state` | **子串匹配**：`selector in _last_page`，非 CSS 选择器（dsl.py:139-150） | `state ∈ {present, absent, text:xxx}`（text 分支断言的是 `state[5:]` 文本子串）；未知 state 该步失败 |
| `call_api method path` | 读仿真 JSON 入 `_last_response` | method 仅入 detail，不影响映射；文件缺失该步失败 |
| `assert_response expect` | `json_path`（dotted 取值，KeyError 该步失败）或整体与 `expect` 相等比较 | **status 断言陷阱**：响应 dict 无 `http_status` 字段时取**期望值本身**兜底（`get("http_status", status)`，dsl.py:178-181）→ 必过；`_last_response is None`（未先 call_api）该步失败 |
| `query_db sql` | 只读白名单校验 → 执行 → 行列表写 `_last_response` | 白名单 `^\s*select`（不区分大小写，dsl.py:91-94）；写 SQL 抛 ValueError → 该步失败 |
| `assert_db sql expect` | 同白名单；`expect` 两形式：`row_count(>=|<=|==|>|<)n` 比较运算符，或 `field=value` 取**首行**该字段（dsl.py:194-210） | 无法解析 expect 该步失败；行列表空时 field=value 断言 None |
| `check_log service pattern` | `re.findall(pattern, content)` 命中数 >0 才过 | `since` 参数收了不用（dsl.py:214），无时间过滤 |

未知动作 / 必填参数缺失在 `DSLStep.model_validate` 就地抛错（词表校验 dsl.py:38-56），**不在单步异常捕获范围内**——直接炸出 execute → Stage 异常 → FAILED（`test_env_lock.py::test_verify_exception_releases_env_lock` 正是用缺参步骤触发此路径）。`_run_step` 里"执行器不支持动作"分支（dsl.py:114-116）因词表前置校验而不可达（死代码）。单步执行期异常（文件/SQL/断言错误）被捕获为 `passed=False`（detail="执行异常: ..."），后续步骤继续。

### 3.4 执行器差异

ssh/docker 执行器 `query_db` 抛 `NotImplementedError` → 被 §3.3 单步捕获记失败——**DSL 数据类动作在远程环境不可用**，且该失败会持续触发重试环空转直至耗尽（能力矩阵见 Spec 06 §4.2）。

## 4. 重试环（完整环 = FIXING → DEPLOYING → VERIFYING）

```
VERIFYING 未过 且 retry_count < max_retry
  → StageResult(status="retry", next_state=FIXING)
  → Orchestrator: task.retry_count += 1（orchestrator.py:153-157）
  → FIXING（attempt = retry_count+1，改用 fixing_retry_v1 模板：
     previous_attempts = 历史 FixRecord 摘要、failure_evidence = 全部失败
     VerifyRecord 的失败步骤 JSON，fixing.py:146-154，见 Spec 05 §4）
  → DEPLOYING（重新取锁/健康检查/快照/部署，Spec 06）
  → VERIFYING（本 spec §2 重走，attempt 已 +1）
  → 再判定 ……
耗尽（retry_count ≥ max_retry）→ LEARNING 失败分支（Spec 08 建讨论介入单）
人工出口：讨论介入回写 action="retry" 时 retry_count **重置 0** 并回 FIXING
  （intervention.py:132-133，FR-MEM-02，test_failure_branch.py::test_discussion_retry_resets_count）
```

**总量修正**：旧版"同一任务最多 `max_retry+1` 次修复-验证循环"不准确——每次人工讨论 retry 都把计数归零，循环总量可被人工决策反复突破；`max_retry`（默认 3，config.py:40 / Task.max_retry models.py:55）只约束**单轮无人介入时**的自动重试。

## 5. 感知对比（_capture_post_fix，verifying.py:84-106）

1. 前置：`settings.perception_enabled` 且 `ctx.perception` 已注入，否则直接返回空串（默认关，config.py:82）；
2. `capture(task, plan, "post_fix")` → `load_snapshot(task_id, "pre_fix")`（修复阶段采集的基线，Spec 05 §2.1 ③；基线缺失返回空，不告警）→ `compare(pre, post)`；
3. 审计 `perception_compare`（resolved/persistent/introduced 三计数）；
4. `introduced` 非空 → risk_notes = "感知对比发现新增异常（疑似引入性缺陷）:" + 前 10 条（`[dimension/kind] key detail`）；
5. 任何异常整段捕获仅 `logger.warning`——**感知失败绝不阻断验证与分流**；risk_notes 只落库供人工复核，不参与 passed 判定。

感知服务本体（三维采集、pre/post 对比、感知侧只读 SQL 强校验）见 `tests/test_perception.py` 与 Spec 05 §R5。

## 6. 锁释放（临界区收口）

- `finally` 块覆盖 §2 全部路径：通过 / 重试 / 耗尽 / 方案缺失 FAILED / DSL 校验异常——**环境锁在这些路径上均由本阶段释放**（verifying.py:77-82）；
- release 返回 True 才审计 `env_lock_release`（无 reason 字段）；已释放（如异常先经 finally）时 Orchestrator 兜底再调返回 False，不再产生 `env_lock_release_on_error` 审计（orchestrator.py:190-201）；
- 部署失败路径的释放（reason=deploy_failed）属 Spec 06 §3.3，四时机对比见彼处表格。

## 7. 异常矩阵

| 场景 | 行为 | 结果 |
|---|---|---|
| 无验证方案行 | S1 判空 | `FAILED`（finally 已释放锁） |
| 步骤 dict 词表外 / 缺必填参数 | model_validate 抛错，逃出单步捕获 | Stage 异常 → `FAILED`（兜底，锁已由 finally 释放） |
| 单步运行期异常（文件缺失、SQL 错、json_path 不存在、写 SQL 被拒） | 捕获为该步 `passed=False` | 计入结论，后续步骤继续
| `assert_response` 时未调过接口 | `_last_response is None` | 该步失败 |
| ssh/docker 上 query_db/assert_db | NotImplementedError 被单步捕获 | 该步失败（重试也无法恢复，见 §3.4） |
| 感知采集/对比异常 | warning + 空备注 | 验证主链路不受影响 |
| 空步骤方案 | `all([])` 空真 | conclusion=passed（见 §9） |
| Stage 级未捕获异常 | Orchestrator 兜底 | `stage_exception` 审计 + `FAILED` |

## 8. 数据与配置（真实字段名，环境变量加 `AUTOBUGFIXER_` 前缀）

- 写：`verify_record`（task_id、attempt、plan_version、conclusion: passed/failed、step_results JSON、risk_notes Text、evidence_uris JSON——逐步骤证据落盘 `evidence_root/verify/task-{id}-attempt-{n}.json` 后写回 URI，无证据时为空列表）、`task_state_history`、`env_lock`（删行）、`audit_log`（verify / perception_compare / env_lock_release / env_lock_renew）；
- 读：`verification_plan`（steps、version）、`environment`（经 resolve_executor）、历史 `VerifyRecord`（重试时被 fixing 读取）、历史 `FixRecord`；
- 配置：`max_retry=3`、`perception_enabled=false`、`perception_evidence_root=./var/evidence`、`env_root=./var/testenv`（仿真环境根）。

## 9. 测试映射（含旧版错引修正）

| 条款 | 测试 | 备注 |
|---|---|---|
| 全过 → conclusion=passed、逐步 passed、verify 审计 | `test_e2e.py::test_end_to_end_full_pipeline`（55-57、73 行断言真实存在） | 另断言 dsl_version=="1.0"、链路 CLOSED |
| 临界区收口锁释放 | `test_e2e.py::test_env_lock_released_after_pipeline` | EnvLock 表空 |
| 验证异常路径锁释放 | `test_env_lock.py::test_verify_exception_releases_env_lock`（93-116） | 缺参步骤 → FAILED + 锁释放 |
| 无验证方案行 → FAILED（S1/OUT-3） | `test_gap_coverage.py::test_verifying_without_plan_fails` | 不产生 VerifyRecord |
| 重试耗尽 → 失败分支 + 讨论 | `test_failure_branch.py` | 测的是**耗尽后** LEARNING 失败分支与讨论介入三回写 |
| 重试环时序（回环重走、attempt 递增、失败证据注入 prompt） | `test_gap_coverage.py::test_retry_loop_timing_and_failure_evidence` | 断言 fixes/verifies attempt 序列与 retry prompt 内容 |
| 人工 retry 重置计数 | `test_failure_branch.py::test_discussion_retry_resets_count` | retry_count==0 且回 FIXING |
| risk_notes / introduced / perception_compare 审计 | `test_api_fields_perception.py::test_perception_wiring`（90-104） | 感知服务本体见 `test_perception.py` |
| 感知默认关 | `test_api_fields_perception.py::test_perception_disabled_by_default` | 注入但不采集 |
| 感知本体（三维/只读 SQL/超时重试/对比） | `test_perception.py` 六用例 | 注意 `test_readonly_sql_enforced` 校验的是**感知侧**白名单 |
| DSL 语义（九动作/白名单只读 SELECT/单步异常捕获/空真） | `test_dsl_plan.py` DSLInterpreter 段 11 用例 | 含 `test_query_db_rejects_write_sql_as_failed_step`（update 被拒） |

## 10. 已知限制

- `click`/`input` 恒过：本地仿真不驱动浏览器（P1 接 Playwright，dsl.py:133）；
- `check_log` 的 `since` 参数收了不用，无时间窗过滤；
- `assert_element` 是子串匹配非 CSS 选择器——`#submit-btn` 实际在全文找该字面串，CSS 语义只是巧合成立；
- `assert_response` 的 status 断言在仿真响应无 `http_status` 字段时取期望值兜底必过——断言强度虚高；
- `_last_response` 被 query_db 与接口断言共享，方案步骤顺序不当会断言错对象（§3.2）；
- ssh/docker 执行器无 `query_db`，DSL 数据类动作在远程环境必败；
- 空步骤方案空真通过（`all([])`）——零验收点等于免检，P1 由 Spec 03 §9.2（方案最少步骤数校验）解决；
- ~~`evidence_uris` 字段存在但无写入点~~（已实现证据落盘：含证据步骤的验证写 JSON 证据文件并回填 URI）；
