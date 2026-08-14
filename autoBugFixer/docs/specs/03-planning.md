# Spec 03 · 验证方案生成（Planning）

| 项 | 值 |
|---|---|
| 涉及状态 | `PLANNING`（执行态）→ `SCORED` 或 `WAIT_PLAN`（阻塞态） |
| 源码 | `src/autobugfixer/pipeline/stages/planning.py`、`pipeline/dsl.py` |
| 提示词 | `prompts/templates/planning_v1.md`（占位符 `bug_block`） |
| 需求 | FR-PRE-03（验证方案生成与高风险确认）、11.4（可执行 DSL） |
| 上游 | 完整性分析（Spec 02） |
| 下游 | 难度评分与准入（Spec 04）；回归验证（Spec 07 消费产出） |
| 介入类型 | `plan_confirm`（指派 `tech_lead`） |

## 1. 目标与职责

让 LLM 基于 Bug 信息产出**结构化、可执行**的回归验证方案：

1. 以受限 DSL（9 个动作词）约束 LLM 输出，杜绝自由文本方案；
2. 方案落库版本化（`verification_plan`，`dsl_version` 字段）；
3. 命中高风险模块的方案必须经人工确认（`WAIT_PLAN`），低风险自动通过。

## 2. 输入与前置条件

- 任务状态 `PLANNING`；
- `ctx.bug`（经 `build_bug_block()` 注入防护）；
- 配置 `HIGH_RISK_MODULES`（默认 `["core-payment", "auth"]`）。

## 3. 处理流程

```
1. prompt = planning_v1.format(bug_block=...)
2. ctx.llm.analyze(prompt, Schema=PlanOutput)
   · DSL 以 JSON Schema 约束输出，校验失败由 Gateway 自动重试（11.4）
3. 风险分级：hit_risk = affected_modules ∩ HIGH_RISK_MODULES（排序）
   risk_level = "high" if hit_risk else "low"
4. 落库 VerificationPlan（version=1, dsl_version=DSL_VERSION="1.0"）
5. 审计 llm_call（prompt_version、plan_id、risk_level）
6. 分流：
   ├─ risk_level=high → need_intervention（plan_confirm）→ WAIT_PLAN
   │    context = {plan_id, steps, hit_risk_modules}
   └─ risk_level=low → success → SCORED（"低风险方案自动通过"）
```

**输出 Schema：`PlanOutput`**

```json
{
  "env_requirements": "环境要求描述",
  "steps": [{"action": "call_api", "params": {"method": "GET", "path": "/health"}, "desc": "调用健康检查"}],
  "expected_results": ["status 字段为 ok"],
  "function_points": ["健康检查接口"],
  "regression_scope": "回归范围说明"
}
```

### 3.1 DSL 动作词表（`pipeline/dsl.py::DSL_ACTIONS`）

| 动作 | 必填参数 | 类别 |
|---|---|---|
| `open_page` | `url` | 页面 |
| `click` | `selector` | 页面 |
| `input` | `selector, value` | 页面 |
| `assert_element` | `selector, state` | 页面 |
| `call_api` | `method, path` | 接口 |
| `assert_response` | `expect` | 接口 |
| `query_db` | `sql` | 数据 |
| `assert_db` | `sql, expect` | 数据 |
| `check_log` | `service, pattern` | 日志 |

`DSLStep` pydantic 校验：动作必须在词表内、`params` 必须覆盖该动作必填参数，否则校验失败触发 LLM 重试。词表外动作在解释执行期也会被拒（双保险，见 Spec 07）。

## 4. 输出与状态迁移

| 分支 | 结果 | 迁移 |
|---|---|---|
| 低风险 | `success` | `PLANNING → SCORED`（携带 artifacts `plan_id`） |
| 高风险 | `need_intervention` | 创建 `plan_confirm` 介入单通知 tech_lead，`PLANNING → WAIT_PLAN` |
| LLM/异常 | `failed`（兜底） | `→ FAILED` |

### 4.1 方案确认回写（`InterventionService.resolve`，result 约定）

```json
{"approved": true, "steps": ["可选：人工调整后的 DSL 步骤"]}
```

- `approved=false` → `WAIT_PLAN → MANUAL`（方案未获确认，转人工）；
- `approved=true` → 
  - 携带 `steps`：覆盖 `plan.steps` 且 `plan.version += 1`（人工调整留版本痕迹）；
  - 写 `confirmed_by`（操作人）与 `confirmed_at`；
  - `WAIT_PLAN → SCORED` 进入评分，随后 `run_until_blocked` 续跑。

## 5. 数据模型

- 写：`verification_plan`（`dsl_version / env_requirements / steps / expected_results / function_points / regression_scope / risk_level / confirmed_by / confirmed_at`）、`task_state_history`、`intervention`、`audit_log`、`llm_usage`。

## 6. 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `HIGH_RISK_MODULES` | `core-payment, auth` | 命中即强制人工确认（FR-PRE-03） |

## 7. 异常与失败处理

- LLM 输出含非法动作/缺参：pydantic 校验失败 → Gateway 按 `stage_max_retry` 重试 → 仍失败 `FAILED`；
- 人工调整后的 `steps` 同样须通过 `DSLStep` 校验（落库时）。

## 8. 人工介入点

**plan_confirm**（tech_lead）：确认或调整高风险模块的验证方案。调整后的步骤是验证阶段的最终执行依据（`version` 递增，取最新版本执行）。

## 9. 安全约束

- DSL 词表 + 必填参数双校验 = LLM 无法生成任意执行逻辑；
- `query_db / assert_db` 在执行期强制只读 SELECT（Spec 07 §3）；
- Bug 文本进入 prompt 前经注入防护。

## 10. 验收标准

- 低风险 Bug（BUG-1001）方案自动通过并进入 `SCORED`；
- `affected_modules` 含 `core-payment`（BUG-1003）时产生 `plan_confirm` 介入单且任务停在 `WAIT_PLAN`（`tests/test_e2e.py`、`test_intervention.py`）；
- 确认回写 `approved=true + steps` 后方案版本 +1、`confirmed_by` 落库、任务进 `SCORED`；
- 确认回写 `approved=false` 后任务转 `MANUAL`。

## 11. 已知限制与演进

- 页面类动作在本地仿真执行器中不驱动真实浏览器（`click/input` 为模拟通过，P1 接 Playwright）；
- 方案不含性能/压力类验证动作；词表扩展需同步更新 `DSL_ACTIONS` 与解释器。
