# Spec 07 · 回归验证（Verifying）

| 项 | 值 |
|---|---|
| 涉及状态 | `VERIFYING`（执行态）→ `LEARNING`（通过或重试耗尽）/ `FIXING`（重试环） |
| 源码 | `src/autobugfixer/pipeline/stages/verifying.py`、`pipeline/dsl.py::DSLInterpreter` |
| 需求 | FR-REG-03（回归验证与证据链）、FR-FIX-02（感知对比）、11.1（临界区收尾）、11.4（DSL）、11.5（重试反馈） |
| 上游 | 部署（Spec 06，锁已持有） |
| 下游 | 经验沉淀（Spec 08）或回 AI 修复（Spec 05 重试） |
| 消费产物 | 最新版本 `verification_plan`（Spec 03 产出，可能经人工调整 version+1） |

## 1. 目标与职责

按验证方案**逐条解释执行 DSL 步骤**，产出结论与证据链，并驱动重试环：

1. DSL 解释执行（9 动作词，逐条留证据摘要）；
2. 感知对比（可选）：修复后快照 vs 修复前基线，新增异常记为风险备注；
3. 三路分流：全过 → 学习；未过且可重试 → 回修复；未过且耗尽 → 学习失败分支；
4. **finally 释放环境锁**——临界区在此收口，任何路径不泄漏。

## 2. 输入与前置条件

- 任务状态 `VERIFYING`；持有 `task.environment_id` 的环境锁；
- 最新 `verification_plan`（`version` 最大者；缺失 → `FAILED`）；
- 执行器：与部署阶段同一解析逻辑（`resolve_executor`）；
- 感知基线：`perception.load_snapshot(task_id, "pre_fix")`（修复阶段采集，可选）。

## 3. 处理流程

```
1. plan = 最新 VerificationPlan；无 → failed → FAILED
2. executor = resolve_executor(ctx)；interpreter = DSLInterpreter(executor)
3. results = interpreter.execute(plan.steps)   # 逐条执行（见 §3.1）
4. passed = all(r.passed)
5. 感知对比（可选，失败不阻断）：post = capture("post_fix")；
   diff = compare(pre, post)；introduced 异常 → risk_notes（前 10 条）
6. 落库 VerifyRecord（conclusion、step_results、risk_notes、plan_version、attempt）
   + 审计 verify
7. 分流（见 §4）
8. finally：释放环境锁（env_locks.release；成功释放审计 env_lock_release）
```

### 3.1 DSL 解释执行语义（本地仿真执行器）

| 类别 | 动作 | 仿真语义 |
|---|---|---|
| 页面 | `open_page url` | 读 `pages/<url>.html` 存为当前页 |
| | `click/input` | 模拟交互直接通过（P1 接 Playwright） |
| | `assert_element selector state` | `state ∈ {present, absent, text:xxx}`，对当前页文本断言 |
| 接口 | `call_api method path` | 读 `api/<path>.json` 存为最近响应 |
| | `assert_response expect` | 支持 `json_path`（dotted 取值）与 `status`（http_status 字段）断言 |
| 数据 | `query_db sql` | 执行环境 `app.db` SQL（**强制只读 SELECT**，否则拒绝） |
| | `assert_db sql expect` | `expect` 支持 `row_count>=n` 比较或 `field=value`（首行） |
| 日志 | `check_log service pattern` | 读 `logs/<service>.log` 正则匹配，命中数 > 0 通过 |

- 未知动作 / 执行异常 → 该步 `passed=False`（detail 记原因），**不中断后续步骤**；
- 每步 `StepResult{action, passed, detail, evidence}`，evidence 为响应体/页面片段/行数据摘要（截 200 字）。

## 4. 输出与状态迁移

| 分支 | 条件 | 结果 | 迁移 | retry_count |
|---|---|---|---|---|
| 通过 | 全部步骤 passed | `success` | `VERIFYING → LEARNING`（成功分支） | 不变 |
| 重试 | 存在失败步骤且 `retry_count < max_retry` | `retry` | `VERIFYING → FIXING` | **+1**（Orchestrator 处理 retry 时递增） |
| 耗尽 | 存在失败步骤且 `retry_count ≥ max_retry` | `success` | `VERIFYING → LEARNING`（失败分支） | 不变 |

重试环总量约束：初始尝试 + `max_retry` 次重试，即同一任务**最多 `max_retry + 1` 次修复-验证循环**（默认 4 次）。重试回修复时失败步骤以 `failure_evidence` 注入下一次修复 prompt（Spec 05 §3）。

artifacts：`verify_record_id`、`failed_steps`（重试/耗尽路径）。

## 5. 数据模型

- 写：`verify_record`（attempt、plan_version、conclusion: passed/failed、step_results[]、risk_notes、evidence_uris）、`task_state_history`、`env_lock`（删除行）、`audit_log`；
- 读：`verification_plan`、`environment`。

## 6. 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `MAX_RETRY` | `3` | 重试上限（比较对象是 `task.retry_count`） |
| `PERCEPTION_ENABLED` | `false` | 感知对比开关 |
| `PERCEPTION_EVIDENCE_ROOT` | `./var/evidence` | 感知证据存储根 |

## 7. 异常与失败处理

- 方案缺失 → `FAILED`；
- DSL 执行期异常（文件缺失、SQL 错误、json_path 不存在）→ 单步失败计入结论，不抛异常；
- **finally 保证锁释放**：通过/重试/耗尽/异常路径均执行 `release`；
- 感知采集/对比异常 → 仅告警，`risk_notes` 置空。

## 8. 人工介入点

无直接介入。耗尽路径的讨论介入由 Spec 08 失败分支创建。

## 9. 安全约束

- `query_db/assert_db` 强制 `^\s*select` 只读白名单（11.4），写操作直接拒绝；
- 执行器路径解析限制在环境根目录内；
- 风险备注（感知 introduced）不改变通过结论，但随 VerifyRecord 落库供人工复核——判定"疑似引入性缺陷"。

## 10. 验收标准

- 全步通过 → `LEARNING` 且 `conclusion=passed`，锁已释放（`tests/test_e2e.py`）；
- 步骤失败且未耗尽 → 回 `FIXING`、`retry_count` 递增、失败步骤进入下次修复 prompt（`test_failure_branch.py`）；
- 耗尽 → `LEARNING` 失败分支（conclusion=failed）；
- 写 SQL（update/delete）被拒绝该步失败（DSL 白名单用例）；
- 感知 introduced 异常写入 `risk_notes` 且不影响 conclusion（`test_perception.py`）；
- 异常路径同样释放锁（`test_env_lock.py`）。

## 11. 已知限制与演进

- 页面/接口动作为本地文件仿真，不发起真实 HTTP/浏览器请求（P1 Playwright + 真实 API 网关）；
- `expect` 断言语法为简化子集（相等/比较），不支持 JSON Schema 断言；
- 证据目前内联 step_results（截断），大对象走 evidence_uris 为 P1 文件存储方向。
