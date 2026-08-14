# Spec 04 · 难度评分与准入（Scoring）

| 项 | 值 |
|---|---|
| 涉及状态 | `SCORED`（在本状态内执行，而非离开它时） |
| 源码 | `src/autobugfixer/pipeline/stages/scoring.py` |
| 提示词 | `prompts/templates/scoring_v1.md`（占位符 `bug_block`、`plan_summary`） |
| 需求 | FR-PRE-04（难度评分与准入阈值）、FR-SYS-02（策略版本化）、设计 9.3 |
| 上游 | 验证方案生成（Spec 03，`PLANNING/WAIT_PLAN → SCORED`） |
| 下游 | AI 修复（Spec 05，`SCORED → FIXING`）或转人工 |
| 介入类型 | 无（超阈值直接 `MANUAL` + 通知，不建介入单） |

## 1. 目标与职责

量化 Bug 的自动修复难度，实现**评分准入**与**先易后难调度**：

1. LLM 三维评分（0-100）+ 策略权重合成综合分；
2. 综合分低于阈值 → 准入自动修复队列；达到/超过阈值 → 转人工并附评分解释；
3. 评分全量落库（可查询、可解释），并支持策略版本化覆盖（在线调权可回退）。

## 2. 输入与前置条件

- 任务状态 `SCORED`；
- `ctx.bug`（注入防护后的 bug_block）；
- 最新 `verification_plan` 的可读摘要（`_plan_summary`：步骤 desc/action + 预期结果，截断 500 字符）——跨阶段数据从库读取，不经 `ctx.data`；
- 策略来源：配置权重/阈值，或生效中的 `strategy_version` 行（`active=True`，优先级更高）。

## 3. 处理流程

```
1. prompt = scoring_v1.format(bug_block=..., plan_summary=...)
2. ctx.llm.analyze(prompt, Schema=ScoreOutput)；审计 llm_call
3. 解析权重与阈值：
   · 默认取 Settings（SCORE_WEIGHT_FIX/VERIFY/CHANGE、ADMISSION_THRESHOLD）
   · 存在生效 StrategyVersion 时覆盖：weights 更新对应键、threshold 覆盖，
     weight_version 标记为 "strategy:v{version}"
4. total = round(fix_difficulty*w_fix + verify_difficulty*w_verify
                 + change_scale*w_change, 2)
5. 全量落库：task.priority_score = total；task.score_detail =
   {三维得分, weights(+version), threshold, rationale}
6. 准入判定：
   ├─ total >= threshold → 通知 developer（附评分明细）
   │    → success → MANUAL（"综合分 x >= 阈值 y，转人工"）
   └─ total <  threshold → success → FIXING（"综合分 x 准入自动修复队列"）
```

**输出 Schema：`ScoreOutput`**（各维度 pydantic 约束 `0 ≤ x ≤ 100`）

```json
{ "fix_difficulty": 20, "verify_difficulty": 10, "change_scale": 15, "rationale": "评分理由" }
```

## 4. 输出与状态迁移

| 分支 | 结果 | 迁移 |
|---|---|---|
| 准入（total < 阈值） | `success` | `SCORED → FIXING`（直接续跑场景）或**停留 SCORED**（预处理模式，见 §4.1） |
| 超阈值 | `success` | `SCORED → MANUAL`，通知 developer |

### 4.1 两种执行路径（重要语义）

评分 Stage 在 `SCORED` 状态内执行，成功迁移目标是 `FIXING`，但存在两种消费方式：

1. **预处理模式**（`run_preprocessing`，`hold_next_states={FIXING}`）：CSV 导入 `--run-analysis`、调度器 `preprocess_pending()` 走此路径。准入后**不做迁移**，写 `admission_hold` 审计、任务停在 `SCORED`，由调度器按 `priority_score` 升序出队（先易后难），出队时由调度器完成 `SCORED → FIXING` 迁移（stage="scheduler"），避免重复评分。
2. **直通模式**（`run_until_blocked`，webhook/API 触发）：评分直接迁移 `SCORED → FIXING` 并连续推进后续阶段。

调度器单轮出队上限 `SCHEDULER_DISPATCH_LIMIT`（默认 2）。

## 5. 数据模型

- 写：`task`（`priority_score`、`score_detail`、状态）、`task_state_history`、`audit_log`、`llm_usage`；
- 读：`verification_plan`（摘要）、`strategy_version`（生效策略）。

`score_detail` 结构（可解释性要求）：

```json
{
  "fix_difficulty": 20, "verify_difficulty": 10, "change_scale": 15,
  "weights": {"fix": 0.4, "verify": 0.3, "change": 0.3, "version": "v1"},
  "threshold": 60, "rationale": "..."
}
```

## 6. 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `SCORE_WEIGHT_FIX / VERIFY / CHANGE` | `0.4 / 0.3 / 0.3` | 三维权重（和应为 1） |
| `ADMISSION_THRESHOLD` | `60` | 综合分 **≥** 阈值转人工（严格小于才准入） |
| `SCHEDULER_DISPATCH_LIMIT` | `2` | 单轮出队上限 |

策略版本（`strategy_version` 表）：`weights = {"fix":…, "verify":…, "change":…, "threshold":…}`，经自我优化评审介入（`optimization` 类型，`apply_strategy`）写入并激活，支持回退（FR-SYS-02）。

## 7. 异常与失败处理

- LLM 评分失败/超预算 → Stage 异常 → `FAILED`（人工重新触发后回 `ANALYZING` 重跑）；
- 无验证方案时 `plan_summary` 以"见验证方案"占位，不阻断评分。

## 8. 人工介入点

无介入单。超阈值的"介入"以 `MANUAL` 终态 + developer 通知实现；策略调优走系统级 `optimization` 介入单（不绑定任务，`task_id=0`）。

## 9. 安全约束

- 评分理由与权重版本全量落库，保证评分决策可追溯（9.3 约束：评分准入需可解释）；
- LLM 输出经 Schema 数值边界校验，无法注入越权内容。

## 10. 验收标准

- 准入任务 `priority_score/score_detail` 落库且权重版本可追溯（`tests/test_scoring.py`）；
- 综合分 ≥ 阈值任务转 `MANUAL` 并发送通知（`test_notifier_writeback.py`）；
- 生效 `StrategyVersion` 覆盖配置权重，`weight_version` 标记为 `strategy:vN`；
- 预处理模式准入后停在 `SCORED`（`admission_hold` 审计），调度器按分数升序出队（`test_scheduler.py`）。

## 11. 已知限制与演进

- 权重和不强制校验为 1（配置责任）；
- 评分不含历史通过率反馈信号；P2 可结合经验库命中率修正难度先验。
