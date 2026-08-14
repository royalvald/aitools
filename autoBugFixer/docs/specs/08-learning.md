# Spec 08 · 经验沉淀与关闭（Learning）

| 项 | 值 |
|---|---|
| 涉及状态 | `LEARNING`（执行态）→ `CLOSED` 或 `WAIT_DISCUSS`（阻塞态） |
| 源码 | `src/autobugfixer/pipeline/stages/learning.py`、`services/experience.py` |
| 提示词 | `prompts/templates/failure_analysis_v1.md`（占位符 `bug_block`、`retry_count`、`max_retry`、`failed_steps`） |
| 需求 | FR-MEM-01（经验入库与去重）、FR-MEM-02（不适用场景与人工讨论）、11.7（平台回写）、FR-SYS-03（知识库导出） |
| 上游 | 回归验证（Spec 07，通过或耗尽）、AI 修复相同 diff 提前终止（Spec 05 §4） |
| 下游 | 终态 `CLOSED`；或失败讨论后 `MANUAL / CLOSED / FIXING` |
| 介入类型 | `discussion`（指派 `developer`） |

## 1. 目标与职责

流水线收口阶段，按最近验证结论走**双分支**：

- **成功分支**：经验条目入库（比对去重合并）→ 通知测试 → 平台回写关闭 → `CLOSED`；
- **失败分支**：LLM 复盘生成"不适用场景" → 落库 → 创建人工讨论介入 → `WAIT_DISCUSS`。

本阶段是系统**自我改进回路**的核心：成功喂经验库（正向复用，Spec 05 §3.2 消费），失败沉淀不适用边界（负向规避）。

## 2. 输入与前置条件

- 任务状态 `LEARNING`；
- 判定依据：最新 `verify_record`（attempt 最大者）的 `conclusion`：
  - `passed`（或经人工讨论判定关闭）→ 成功分支；
  - `failed` 或**无任何验证记录**（如修复阶段相同 diff 提前终止且从未验证）→ 失败分支；
- 成功分支另需：最新 `fix_record`（fix_pattern 素材）。

## 3. 处理流程

```
last_verify = 最新 VerifyRecord
verified = last_verify 存在且 conclusion == "passed"
├─ verified → 成功分支 §3.1
└─ 否则    → 失败分支 §3.2
```

### 3.1 成功分支（`_success_branch`）

```
1. category = 关键词分类（title+description）：
   接口类（接口/api/API/请求）> 数据类（数据/SQL/库）> 界面类（页面/界面/按钮/显示）
   > 环境类（部署/环境/配置）> 其他
2. ExperienceService.upsert（比对去重，FR-MEM-01）：
   · 唯一键：category + problem_signature(=bug.title) + status=active
   · 已存在 → 合并更新（symptoms=actual 截500 / fix_pattern=fix.summary 截500
     / verification_points=通过步骤拼接 / applicable_conditions=env 版本），
     source_task_ids 追加，version += 1
   · 不存在 → 新增
   · root_cause_pattern 置空（P1 由 LLM 归因总结填充）
3. 通知 tester：Bug 已自动修复关闭（含任务链接）
4. success → CLOSED
   （平台回写由 Orchestrator 迁移钩子按 status_map 完成：CLOSED → "已关闭"，11.7）
```

### 3.2 失败分支（`_failure_branch`）

```
1. failed_steps = 最新 VerifyRecord 未通过步骤（无记录则为空）
2. analysis = LLM 复盘（Schema=FailureAnalysis，失败回退空对象走规则模板兜底）：
   { condition_desc: 何种条件下系统不适用, reason: 失败原因, discussion_topic: 讨论议题 }
3. 落库 InapplicableCase（analysis 各字段为空时用规则模板填充：
   条件=模块/环境；原因=重试次数+失败步骤；议题=请评审并决定人工接手）
4. need_intervention（discussion，developer）：
   context = { inapplicable_case_id, reason, failed_steps }
5. → WAIT_DISCUSS（"已达重试上限，生成不适用场景与讨论议题"）
```

## 4. 输出与状态迁移

| 分支 | 结果 | 迁移 | 平台回写 |
|---|---|---|---|
| 成功 | `success` | `LEARNING → CLOSED`，`task.closed_at` 由 Orchestrator 写入 | `CLOSED → 已关闭` |
| 失败 | `need_intervention` | 创建 discussion 介入单，`LEARNING → WAIT_DISCUSS` | 默认 status_map 无映射，不回写 |

### 4.1 失败讨论回写（`InterventionService.resolve`，result 约定）

```json
{"action": "manual_fix"}   // 人工接手 → WAIT_DISCUSS → MANUAL
{"action": "close"}        // 判定可关闭（如非缺陷/重复单）→ WAIT_DISCUSS → CLOSED
{"action": "retry"}        // 人工决定再试 → WAIT_DISCUSS → FIXING，且 retry_count 重置为 0（FR-MEM-02）
```

回写后 `run_until_blocked` 续跑（retry 路径将重新经历修复-部署-验证全链，attempt 重新从 1 计）。

## 5. 数据模型

- 写：`experience`（upsert/version/hit_count）、`inapplicable_case`、`task`（closed_at、状态）、`task_state_history`、`intervention`、`audit_log`、`llm_usage`（失败复盘调用）；
- 读：`verify_record`、`fix_record`、`bug_ticket`。

## 6. 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `STATUS_MAP` | `CLOSED→已关闭` 等 | 状态回写映射（11.7） |
| `NOTIFIER_TYPE / IM_WEBHOOK_URL` | `log` / — | 通知通道 |

经验库导出：CLI `autobugfixer-export --format markdown`（导出前脱敏，FR-SYS-03）。

## 7. 异常与失败处理

- LLM 复盘失败 → 回退规则模板，**失败分支不因 LLM 故障而中断**；
- 经验 upsert 依赖唯一性弱（无 DB 约束，靠查询去重），并发极小概率重复条目（P1 加唯一索引）；
- 平台回写失败：重试一次后告警，不影响任务 `CLOSED`。

## 8. 人工介入点

**discussion**（developer）：失败 Bug 的最终裁决——人工接手 / 关闭 / 重试。讨论结论同时驱动 `InapplicableCase` 的后续处置（库中 `status=open`，人工闭环后更新）。

## 9. 安全约束

- 经验内容来自 Bug/修复摘要，入库前文本截断（500 字）；
- 知识库导出经脱敏（`security/redact.py`）；
- 平台回写内容为状态映射 + 固定评论模板，不含敏感原始数据。

## 10. 验收标准

- 成功路径：经验条目落库（同签名重复成功 → version+1 而非新增）、tester 收到通知、任务 `CLOSED`、平台收到"已关闭"回写（`tests/test_e2e.py`、`test_experience_reuse.py`、`test_notifier_writeback.py`）；
- 失败路径：`InapplicableCase` + discussion 介入单生成，任务停 `WAIT_DISCUSS`（`test_failure_branch.py`）；
- 讨论回写三动作分别迁移 `MANUAL / CLOSED / FIXING`，retry 动作重置 `retry_count`（`test_intervention.py`）；
- 无验证记录进入 LEARNING（相同 diff 终止）→ 走失败分支不抛错。

## 11. 已知限制与演进

- 分类为关键词规则（P1 改 LLM 分类，类目可配置）；
- `root_cause_pattern` 未沉淀（P1 LLM 归因）；
- 不适用场景仅入库展示，未反向阻断后续同类任务准入（P2：评分阶段消费 InapplicableCase 抬高难度分）。
