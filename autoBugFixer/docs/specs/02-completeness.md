# Spec 02 · 完整性分析（Completeness）

| 项 | 值 |
|---|---|
| 涉及状态 | `ANALYZING`（执行态）⇄ `WAIT_INFO`（阻塞态）→ `PLANNING / MANUAL` |
| 源码 | `src/autobugfixer/pipeline/stages/completeness.py` |
| 提示词 | `prompts/templates/completeness_v1.md`（占位符 `bug_block`） |
| 需求 | FR-PRE-02（信息完整性自动分析）、设计 4.1 / 4.5 |
| 上游 | 接入与标准化（Spec 01） |
| 下游 | 验证方案生成（Spec 03） |
| 介入类型 | `info_supplement`（指派 `tester`） |

## 1. 目标与职责

判定 Bug 信息是否足以支撑自动修复；信息不足时向测试人员发起补充请求，并以**往返上限**防止"补充—分析"死循环：

1. 规则快路径：关键字段非空校验（不耗 LLM 配额）；
2. LLM 评估：文本质量与可修复性判断（结构化输出）;
3. 不足则发起 `info_supplement` 介入，任务阻塞在 `WAIT_INFO`。

## 2. 输入与前置条件

- 任务状态 `ANALYZING`（`DISCOVERED` 亦路由到本 Stage，兜 ingestion 未推进的场景）；
- `ctx.bug`：BugTicket 全字段；
- 必填字段清单（常量 `REQUIRED_FIELDS`）：`title / description / repro_steps / expected / actual / env_version`。

## 3. 处理流程

```
1. 规则快路径：遍历 REQUIRED_FIELDS，任一为空
   └─ 缺失 → _need_supplement(rule_based=True)，跳过 LLM
2. LLM 评估（ctx.llm.analyze，Schema=CompletenessEval）：
   prompt = completeness_v1.format(bug_block=build_bug_block(ctx))
   · bug_block 经注入防护（检测留痕 + 不可信包裹，见总览横切 3）
   · 计量写 llm_usage；预算超限抛 BudgetExceededError → Stage 异常 → FAILED
   · 审计 llm_call（含 prompt_version、complete 结论）
3. 结果分流：
   ├─ complete=true  → success → PLANNING（"完整性评估通过"）
   └─ complete=false → _need_supplement(missing, suggestions)
        ├─ task.info_rounds >= settings.max_info_rounds（默认 2）
        │    → success → MANUAL（"补充往返达上限仍未完整，转人工"，防死循环 4.1.2）
        └─ 未达上限 → need_intervention：
             InterventionRequest(type=info_supplement, assignee_role=tester,
                                 wait_state=WAIT_INFO,
                                 context={missing_fields, suggestions, rule_based})
```

**输出 Schema：`CompletenessEval`**

```json
{ "complete": true, "missing": ["字段名"], "suggestions": ["建议补充内容"] }
```

## 4. 输出与状态迁移

| 分支 | 结果 | 迁移 |
|---|---|---|
| 评估通过 | `success` | `ANALYZING → PLANNING` |
| 信息不足（未达上限） | `need_intervention` | 创建介入单 + 通知 tester，`ANALYZING → WAIT_INFO` |
| 往返超上限 | `success` | `ANALYZING → MANUAL`（终态，可人工重新触发） |
| Stage 异常 | `failed`（Orchestrator 兜底） | `→ FAILED` 断点续跑 |

### 4.1 唤醒路径（离开 WAIT_INFO）

| 路径 | 触发 | 行为 |
|---|---|---|
| 介入回写 | API `POST /interventions/{id}/resolve`，result=`{"fields": {字段: 值}}` | 合并字段到 BugTicket → `info_rounds += 1` → `WAIT_INFO → ANALYZING` 重析 → `run_until_blocked` 续跑 |
| 平台同步 | 平台侧补充后轮询/webhook 发现数据变化（Spec 01 §3.1） | 同上（介入单自动关闭） |

## 5. 数据模型

- 写：`task`（`info_rounds`、状态）、`task_state_history`、`intervention`（创建/关闭）、`audit_log`、`llm_usage`；
- 读：`bug_ticket`。

## 6. 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `MAX_INFO_ROUNDS` | `2` | 补充往返上限，超过转 MANUAL |
| `STAGE_MAX_RETRY` | `2` | LLM 结构化输出校验失败的重试次数（Gateway 内） |
| `TASK_TOKEN_BUDGET` / `DAILY_TOKEN_BUDGET` | 100k / 1M | 预算约束（11.3） |

## 7. 异常与失败处理

- LLM 输出不符合 Schema：Gateway 按 `stage_max_retry` 自动重试；仍失败抛异常 → `FAILED`；
- 预算超限：`BudgetExceededError` → `FAILED`，等待人工重新触发；
- 注入检测命中：不阻断，仅审计 `injection_detected`。

## 8. 人工介入点

**info_supplement**：指派 `tester`；context 携带缺失字段与补充建议；`deadline` 默认空（可由介入服务按 SLA 补齐），超时由调度器 SLA 扫描处理（`remind`/`suspend`，见配置 `INTERVENTION_*`）。

## 9. 安全约束

Bug 自由文本（title/description 等）属于不可信输入：进入 prompt 前必须经 `build_bug_block()` 做注入模式检测与边界包裹。

## 10. 验收标准

- 六个必填字段任一为空即触发 `WAIT_INFO` 且不调用 LLM（`tests/test_e2e.py` BUG-1002 路径）；
- 介入回写补充字段后任务回到 `ANALYZING` 并通过评估进入 `PLANNING`；
- `info_rounds` 达 `max_info_rounds` 后不再发起介入，直接 `MANUAL`（防死循环用例）；
- 平台同步唤醒与介入回写两条路径 `info_rounds` 均递增、口径一致。

## 11. 已知限制与演进

- 快路径仅判空，不含格式/质量规则（如复现步骤最少步数）；
- 附件内容未参与完整性判断；P1 可接入附件解析。
