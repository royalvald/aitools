# 阶段 Spec 文档总览与公共约定

本目录按架构阶段拆分规格说明（spec），每篇 spec 对应状态机的一个区段，内容以当前实现为准（`src/autobugfixer/`），并标注对应需求编号（FR-xx / 设计文档章节号）。

## 文档索引

| # | 阶段 | 涉及状态 | 源码 | 需求 |
|---|---|---|---|---|
| [01](01-ingestion.md) | 接入与标准化 | `DISCOVERED → ANALYZING` | `ingest/ingestion.py`、`platform/__init__.py` | FR-PRE-01 |
| [02](02-completeness.md) | 完整性分析 | `ANALYZING ⇄ WAIT_INFO` | `completeness/stage.py` | FR-PRE-02 |
| [03](03-planning.md) | 验证方案生成 | `PLANNING → WAIT_PLAN/SCORED` | `planning/stage.py`、`dsl/__init__.py` | FR-PRE-03、11.4 |
| [04](04-scoring.md) | 难度评分与准入 | `SCORED` | `scoring/stage.py` | FR-PRE-04、FR-SYS-02 |
| [05](05-fixing.md) | AI 修复 | `FIXING` | `fixing/stage.py`、`stages/common.py` | FR-FIX-01/02、11.2、11.5 |
| [06](06-deploying.md) | 部署 | `DEPLOYING ⇄ WAIT_ENV` | `deploying/stage.py` | FR-REG-01/02、11.1 |
| [07](07-verifying.md) | 回归验证 | `VERIFYING` | `verifying/stage.py`、`dsl/__init__.py` | FR-REG-03、11.4 |
| [08](08-learning.md) | 经验沉淀与关闭 | `LEARNING → WAIT_DISCUSS/CLOSED` | `learning/stage.py` | FR-MEM-01/02、11.7 |

## 状态机全景

```
DISCOVERED → ANALYZING → PLANNING → SCORED → FIXING → DEPLOYING → VERIFYING → LEARNING → CLOSED
                ⇅           ⇅         ↓        ↑ ↓       ⇅            ↓ ↑         ↓ ⇅
            WAIT_INFO    WAIT_PLAN   MANUAL ←───┘ └──────┘ WAIT_ENV  重试环     WAIT_DISCUSS
                ↓                                    (锁释放/API 唤醒)      ↓
             (≤2 轮)                                                     MANUAL/CLOSED/FIXING
任何非终态 → FAILED（可断点续跑）/ CANCELLED；终态：CLOSED、MANUAL、CANCELLED
```

- 合法迁移表：`core/state.py::LEGAL_TRANSITIONS`；非法迁移抛 `IllegalTransitionError`。
- 阻塞态 `BLOCKING_STATES = {WAIT_INFO, WAIT_PLAN, WAIT_ENV, WAIT_DISCUSS}`：Orchestrator 到达即停，等待外部事件（介入回写 / 平台同步 / API 唤醒）。
- 终态 `TERMINAL_STATES = {CLOSED, MANUAL, CANCELLED}`（MANUAL 可人工重新触发，非绝对终态）。

## Stage 插件协议（FR-SYS-01，设计 3.2）

所有阶段实现统一协议，由 `Orchestrator`（`runtime/orchestrator.py`）按 `STATE_TO_STAGE` 路由表调度：

```python
class Stage(Protocol):
    name: str
    def run(self, ctx: TaskContext) -> StageResult: ...
```

**TaskContext**（`core/stage.py`）承载任务、标准化 Bug、DB 会话与全部服务句柄（LLM、平台、执行器、通知、审计、介入、环境锁、修复通道、感知）。关键属性：`attempt = task.retry_count + 1`（当前修复尝试次数，1 起始）。跨阶段数据一律落库按 id 查询，`ctx.data` 仅在单次 `run` 内有效。

**StageResult 四类结果**及 Orchestrator 处理方式：

| status | 语义 | Orchestrator 动作 |
|---|---|---|
| `success` | 本阶段完成 | 迁移到 `next_state`（必填） |
| `need_intervention` | 需人工介入 | 创建 `Intervention` 介入单（含通知推送），迁移到 `intervention.wait_state` 阻塞态 |
| `retry` | 重试环回退 | `task.retry_count += 1` 后迁移到 `next_state`（当前仅 VERIFYING→FIXING 使用） |
| `failed` | 失败 | 迁移到 `next_state`（缺省 `FAILED`） |

Stage 内未捕获异常由 Orchestrator 兜底：写 `stage_exception` 审计、释放任务持有的环境锁、迁移到 `FAILED`（断点续跑）。

## 横切机制（各阶段共用）

1. **审计留痕**（`core/audit.py`）：追加写 `audit_log`，关键动作（状态迁移、LLM 调用、命令执行、介入、注入检测、经验命中、锁操作）均留痕，保留 ≥180 天。
2. **平台状态回写**（`platform/writeback.py`，11.7）：每次状态迁移后按 `status_map` 映射回写缺陷平台；失败重试一次后告警（`platform_writeback_failed`），**绝不阻塞主流程**。默认仅映射 `CLOSED/WAIT_INFO/MANUAL`。
3. **提示词注入防护**（11.2 输入侧）：Bug 文本进入任何 LLM prompt 前必须经 `build_bug_block()`：`detect_injection` 模式检测（命中写 `injection_detected` 审计，不阻断）+ `wrap_untrusted` 不可信边界包裹 + 超长字段截断。仓库代码检索片段（code_evidence）、候选画像清单、技能库、经验条目等二阶外部数据同口径包裹。
4. **LLM 预算治理**（11.3）：所有 LLM 调用走 `LLMGateway.analyze()/run_fix_agent()` 统一入口，调用前检查单任务/日预算（超限抛 `BudgetExceededError`），调用后计量写 `llm_usage`；结构校验失败的重试**附校验错误反馈**（非原样重发），输出上限 `LLM_MAX_TOKENS` 可配（planning 放宽 8192）。
5. **提示词版本化**：模板存放于 `prompts/templates/<name>_<version>.md`，`load_prompt(name)` 加载、`render_prompt(name, **fields)` 渲染并按 `<<<SYSTEM_END>>>` 标记切分 system/user 通道（规则进 system、数据进 user；标记本身不进入 prompt，仅插标记不升版本），`prompt_version(name)` 取版本号随记录落库供审计回放。
6. **通知**（`intervention/notifier.py`）：角色包括 `tester / developer / tech_lead / ops / manager`；实现 `log`（默认）与 `im`（企业微信/钉钉 webhook）。
7. **环境锁**（11.1，详见 06/07 spec）：`environment_id` 粒度 DB 行互斥，带租约（默认 30 分钟）；临界区 = DEPLOYING 起持锁、VERIFYING 结束释放。

## 执行入口与运行模式

| 入口 | 行为 |
|---|---|
| `Orchestrator.run_task(id)` | 执行当前状态对应的单个 Stage（单步） |
| `Orchestrator.run_until_blocked(id)` | 连续推进直到阻塞态/终态（webhook、API 触发） |
| `Orchestrator.run_preprocessing(id)` | 仅跑预处理三阶段；评分准入后停在 `SCORED`（`admission_hold` 审计），不自动进入修复 |
| `Scheduler.run_round()`（常驻） | 轮询拉新 → 推进预处理（含 SCORED 未评分补评）→ 回收过期环境锁 → **回收孤儿 in-flight 任务**（FIXING/DEPLOYING/VERIFYING/LEARNING，认领租约防双驱）→ **唤醒 WAIT_ENV**（锁空闲按优先级）→ 按 `priority_score` 升序出队已评分 `SCORED` 任务（`scheduler_dispatch_limit` 上限）→ 介入 SLA 扫描 |
| API `POST /tasks/{id}/retry` | 人工唤醒：FAILED 按 `current_stage` 断点续跑（fixing→FIXING、deploying/verifying→DEPLOYING、learning→LEARNING，其余→ANALYZING）；MANUAL→ANALYZING 重跑预处理；WAIT_ENV→DEPLOYING 抢锁 |
| API `POST /tasks/{id}/cancel` | 人工取消：→CANCELLED，关闭待办介入单并释放环境锁 |

## Spec 统一模板

每篇 spec 包含：目标与职责、输入与前置条件、处理流程、输出与状态迁移、数据模型、配置项、异常与失败处理、人工介入点、安全约束、验收标准（对应测试）、已知限制与演进方向。

## 模块路径映射（2026-08 目录树状重组）

各 spec 正文中的源码路径为重组前的历史写法，阅读时按下表映射到当前结构（正文保持原样，作为版本演进留痕）：

| spec 中的旧路径 | 当前路径 |
|---|---|
| `core/*` | `common/core/*` |
| `dsl/*` | `common/dsl/*` |
| `prompts/*` | `common/prompts/*` |
| `security/*` | `common/security/*` |
| `ingest/*`、`completeness/*`、`planning/*`、`scoring/*`、`fixing/*`、`deploying/*`、`verifying/*`、`learning/*` | `features/<同名>/*` |
| `knowledge/*`、`perception/*`、`intervention/*`、`optimization/*` | `features/<同名>/*` |
| `platform/*` | `adapters/platform/*` |
| `env/*` | `adapters/env/*` |
| `web/*` | `api/web/*` |
| `cli.py` / `export_cli.py` / `scheduler_cli.py` | `cli/import_cli.py` / `cli/export_cli.py` / `cli/scheduler_cli.py` |
| `runtime/*`、`api/*` | 位置不变 |
