# Spec 04 · 难度评分与准入（Scoring）

| 项 | 值 |
|---|---|
| 涉及状态 | `SCORED`（在本状态内执行，而非离开它时） |
| 源码 | `src/autobugfixer/scoring/stage.py` |
| 提示词 | `prompts/templates/scoring_v3.md`（占位符 `bug_block`、`plan_summary`；v3：锚点区间+rationale 可反推 + 数据后置分通道与合法 JSON 尾注） |
| 需求 | FR-PRE-04（难度评分与准入阈值）、FR-SYS-02（策略版本化）、设计 9.3 |
| 上游 | 验证方案生成（Spec 03，`PLANNING/WAIT_PLAN → SCORED`） |
| 下游 | AI 修复（Spec 05，`SCORED → FIXING`）或转人工（`SCORED → MANUAL`） |
| 介入类型 | 任务级无（超阈值直接 `MANUAL` + 通知，不建介入单）；系统级 `optimization` 介入单间接调优本阶段参数 |

## 1. 目标与可衡量结果

| # | 结果 | 验证方式 |
|---|---|---|
| R1 | 每任务恰好 1 次 LLM 评分调用，产出三维分数（各 0-100）+ 评分理由，数值越界被 Schema 拒绝并重试 | llm_usage 留痕；`test_low_score_admitted` |
| R2 | 综合分由**本地代码**按当前生效权重加权合成（round 2 位），三维得分、权重、权重版本、阈值、理由全量落库，任一历史评分可逐项复算 | `score_detail` 落库断言；`test_low_score_admitted` |
| R3 | 准入判定：综合分严格小于阈值 → 自动修复队列；大于等于阈值 → `MANUAL` + developer 通知附评分明细 | `test_high_score_to_manual` |
| R4 | 生效中 `strategy_version` 覆盖配置权重与阈值，`weight_version` 标记 `strategy:vN`；策略经评审介入单写入、可回退，下一次评分即生效 | `test_optimization_full_flow` |
| R5 | 预处理模式准入后**停在 SCORED**（`admission_hold` 审计留痕），调度器按 `priority_score` 升序出队（先易后难），单轮上限可配，出队迁移 stage="scheduler" 留痕 | `test_round_dispatches_scored_tasks` |
| R6 | LLM 校验失败重试耗尽（共 3 次尝试）→ `FAILED`；断点续跑回 `ANALYZING` 重走预处理链（完整性→方案→评分，重新消耗调用） | 网关重试机制；异常路径见 §5 |

## 2. 输入契约与状态流

### 2.1 输入（LLM 收到的全部证据，一段 prompt 四个部分）

| 部分 | 内容 | 来源与规则 |
|---|---|---|
| ① 指令 | 角色一句话 + "从三个维度（各 0-100 分）评估自动化修复难度" | scoring 模板（当前 v2）正文 |
| ② bug_block | Bug 结构化文本 7 行（标题/描述/复现步骤/期望结果/实际结果/环境版本/影响模块） | `build_bug_block` 拼装；先过 6 正则注入检测（命中留痕不阻断），再包 `<untrusted_bug_data>` 边界 |
| ③ plan_summary | 最新验证方案可读摘要 | 从库读 `version` 最大的方案；每步取 `desc`（无 desc 则 `action + params JSON`）；末尾拼 `预期: {...}` 一行；**整体截断 500 字符**；无方案时占位"见验证方案"，不阻断 |
| ④ 维度定义与输出格式 | 一行维度名 + 括号释义 + JSON 输出格式 | scoring 模板（当前 v2）末行 |

**评分者看不到**（as-built 事实，写明以免误解）：仓库代码、历史相似 bug、经验库信号、方案的 `function_points`/`regression_scope`/`risk_level`、权重与阈值。

### 2.2 状态流（场景标注）

```
场景 A：综合分 < 阈值（准入）
  SCORED（评分阶段执行）
    → 预处理模式：不迁移，写 admission_hold 审计，停留 SCORED
        → 调度器出队：SCORED → FIXING（stage="scheduler" 留痕）→ 连续推进
    → 直通模式：SCORED → FIXING（评分阶段自身迁移）→ 连续推进

场景 A'：综合分 < 阈值 且 生效策略收紧（阈值 54 → 15.5 仍入队；阈值 10 → 转人工）
  同场景 A/B，判定结果随生效策略版本变化，评分本身不重算

场景 B：综合分 ≥ 阈值（超阈值）
  SCORED（评分阶段执行）
    → 通知 developer（附 score_detail 明细，内容截断 500 字符）
    → MANUAL（转人工终态，"综合分 x ≥ 阈值 y，转人工"）
    → 人工出口（非本阶段行为，状态表允许）：MANUAL → ANALYZING（换策略重评）/ FIXING（人工强制修复）/ CANCELLED

场景 C：LLM 调用失败 / Schema 校验 3 次均失败 / 超预算
  SCORED（评分阶段执行）
    → 异常 → FAILED（stage_exception 审计）
    → 人工重新触发：FAILED → ANALYZING（断点续跑语义：重走完整预处理链，非只重跑评分）
```

## 3. 处理规则

### B1 · 评分输入契约

| # | 规则 |
|---|---|
| B1-1 | prompt 固定四段（§2.1 ①-④），无其他输入通道；bug_block 注入防护与完整性/方案阶段共用同一实现 |
| B1-2 | plan_summary 跨阶段**从库读取**（version 降序取第一条），不经 ctx.data（单次 stage 内有效，不能跨阶段传递） |
| B1-3 | plan_summary 截断 500 字符；超长方案只保留前 500 字符进入评分证据 |
| B1-4 | 无验证方案时以"见验证方案"占位继续评分（防御路径：正常流程评分必有上游方案） |
| B1-5 | 权重与阈值不进入 prompt——评分与准入策略解耦（见 B5-4） |

### B2 · LLM 评分行为与输出契约

| # | 规则 |
|---|---|
| B2-1 | 模板对"怎么打分"的全部指示为三句话：角色一句、维度一行（每维 4-6 字括号释义）、输出格式一行。**无分档锚点、无 few-shot 示例、无推理引导、无温度控制**——打分尺度完全由模型自身知识生成（v1 现状，v2 见 §8） |
| B2-2 | 三维语义（模板字面）：`fix_difficulty`（解决难度：定位+改代码）、`verify_difficulty`（回归验证难度）、`change_scale`（改动项规模）。证据与维度的对应由模型自行从 7+1 段文本联想，代码不做映射 |
| B2-3 | 输出契约 `ScoreOutput`：三维度 float（`ge=0, le=100` 硬边界）+ `rationale: str`（默认空串允许为空，原样落库，质量无人校验） |
| B2-4 | `rationale` 是评分推理的唯一留痕；CSV 场景"影响模块: 未标注"时 change_scale 实际缺乏直接证据，仍由模型给出 |

### B3 · 数值边界与失败重试

| # | 规则 |
|---|---|
| B3-1 | 任一维度越界（如 120、-5）→ pydantic 校验失败 → 网关重试（`stage_max_retry+1` = 共 3 次尝试） |
| B3-2 | 3 次均失败 → 抛 ValueError → stage 异常 → `FAILED`（stage_exception 审计） |
| B3-3 | 超预算（预算检查在调用前）→ 直接异常 → `FAILED` |
| B3-4 | 分数类型为 float，小数合法（模板写 "0-100"，schema 收 float） |

### B4 · 权重与阈值解析（两来源，策略优先）

| # | 规则 |
|---|---|
| B4-1 | 默认来源：配置 `SCORE_WEIGHT_FIX/VERIFY/CHANGE`（0.4/0.3/0.3）+ `ADMISSION_THRESHOLD`（60），`weight_version = "v1"`（代码常量 WEIGHT_VERSION） |
| B4-2 | 存在生效 `strategy_version`（active=True）时**部分合并**：只覆盖策略中出现的权重键，缺的键沿用配置默认；阈值被策略 `weights["threshold"]` 覆盖（as-built：阈值混装在 weights 字典里）；`weight_version = "strategy:v{N}"` |
| B4-3 | 权重和**不校验为 1**（配置责任；测试用 1.0/0/0 验证过） |
| B4-4 | 策略闭环：`optimization` 介入单（task_id=0，系统级）→ 人批准 → 写入并激活 `strategy_version` → **下一次评分即生效** → `rollback_strategy` 可回退到旧版本 |
| B4-5 | 同一任务换策略版本后需经 `MANUAL → ANALYZING` 人工重新触发才会重评；已落库的 score_detail 保留当时的权重版本，历史评分不受后续策略变化影响 |

### B5 · 合成计算与准入判定

| # | 规则 |
|---|---|
| B5-1 | `total = round(fix×w_fix + verify×w_verify + change×w_change, 2)`——纯本地算术，LLM 不参与合成 |
| B5-2 | `total >= threshold` → `MANUAL`（**严格小于才准入**：恰好 60 分转人工）；通知 developer，标题含平台 bug 号与分数，内容为 score_detail 字符串（截断 500 字符） |
| B5-3 | `total < threshold` → 目标 FIXING；`priority_score = total` 落库供调度排序 |
| B5-4 | **评分离策**：LLM 打分时不知道权重与阈值——评分（模型判断）与准入策略（权重/阈值/策略版本）完全解耦，策略可在线换版本而不改变评分语义 |
| B5-5 | 无论准入与否，`score_detail` 均全量落库（结构见 §6），`artifacts = {"score": total}` |

### B6 · 消费路径与调度出队

| # | 规则 |
|---|---|
| B6-1 | **预处理模式**（CSV `--run-analysis`、调度器 `preprocess_pending`）：`hold_next_states={FIXING}`，评分成功且目标为 FIXING 时**不迁移**，写 `admission_hold` 审计（含 held_next 与 message），任务停留 SCORED |
| B6-2 | 调度器 `dispatch_scored`：按 `priority_score` 升序取 SCORED 任务，单轮上限 `SCHEDULER_DISPATCH_LIMIT`（默认 2）；出队即做 `SCORED → FIXING` 迁移（stage="scheduler"，message="调度器按优先级出队"），随后 `run_until_blocked` 连续推进——**不重复评分** |
| B6-3 | **直通模式**（API 触发，`run_until_blocked`）：评分阶段自身完成 `SCORED → FIXING` 迁移并连续推进后续阶段 |
| B6-4 | 预处理步只处理 ANALYZING/PLANNING 任务，不碰 SCORED（避免重复评分），SCORED 统一由出队步消费 |
| B6-5 | 出队后任务失败不影响同轮其他任务出队（逐任务 try/except，异常记日志） |

## 4. 样本预期（examples/bugs_sample.csv）

| Bug | 到达本阶段 | LLM 调用 | 预期结果 |
|---|---|---|---|
| BUG-2001/2003/2004/2005 | 是（完整性通过、方案已生成） | 各 1 次评分调用 | 综合分 = 三维得分按当前生效权重加权；**准入或转人工由评估结论决定**（三维得分是 LLM 判断，规则只负责算术与比较）。预处理模式下准入者停 SCORED，等调度器按分升序出队 |
| BUG-2002 | 否（完整性不足停在 WAIT_INFO） | 0 | 不进入评分 |

## 5. 异常与失败处理

| 异常 | 行为 | 终态/去向 |
|---|---|---|
| LLM 输出越界/非法 JSON | Schema 校验失败重试，共 3 次尝试 | 耗尽 → `FAILED` |
| LLM 服务不可用 | 网关重试 3 次（异常不分类，均重试） | 耗尽 → `FAILED` |
| 超预算 | 调用前预算检查直接拒绝 | `FAILED` |
| 无验证方案 | "见验证方案"占位，不阻断 | 正常评分 |
| 启动时 LLM 配置错误 | 不进入本阶段（Spec 02 B0 预检拦截：CLI/调度器 rc=2，API 拒绝启动或降级） | — |

## 6. 数据落库与审计

**写**：`task`（`priority_score`、`score_detail`、状态）、`task_state_history`（迁移留痕，含 scheduler 出队）、`audit_log`、`llm_usage`。
**读**：`verification_plan`（摘要）、`strategy_version`（生效策略）。

`score_detail` 结构（可解释性要求，任一历史评分可逐项复算）：

```json
{
  "fix_difficulty": 20, "verify_difficulty": 15, "change_scale": 15,
  "weights": {"fix": 0.4, "verify": 0.3, "change": 0.3, "version": "v1"},
  "threshold": 60,
  "rationale": "评分理由（LLM 自由文本，可为空）"
}
```

审计动作：`llm_call`（stage/prompt_version/score）、`admission_hold`（预处理模式准入留痕）、`stage_exception`（失败）、状态迁移 history。

## 7. 验收标准与用例映射

| # | Given / When / Then | 用例 |
|---|---|---|
| A1 | Given 完整性/方案已过 When 评分返回 20/15/10 Then priority_score=15.5、score_detail 含 rationale 与 weights.version="v1"，全链路至 CLOSED | `test_scoring.py::test_low_score_admitted` |
| A2 | Given 同上 When 评分返回 90/90/90 Then 转 MANUAL、score_detail.threshold=60 | `test_scoring.py::test_high_score_to_manual` |
| A3 | Given 权重改为 1.0/0/0 When 评分 70/0/0 Then 综合 70 ≥ 60 转 MANUAL（权重可配） | `test_scoring.py::test_weights_configurable` |
| A4 | Given 库中有带 desc 步骤的方案 When 评分执行 Then prompt 含"验证方案摘要"、各步 desc、预期行（跨阶段从库读取） | `test_scoring.py::test_scoring_prompt_includes_plan_summary` |
| A5 | Given 生效 strategy:v1 阈值 54 When 评分 15.5 Then 仍入队且 weights.version="strategy:v1"；收紧至 v2 阈值 10 重评 Then 转 MANUAL；回退 v1 重评 Then 恢复入队 | `test_optimization.py::test_optimization_full_flow` |
| A6 | Given 任务经预处理停在 SCORED When 调度器 run_round Then 按分出队、迁移 stage="scheduler" 留痕、推进至 CLOSED | `test_scheduler.py::test_round_dispatches_scored_tasks` |
| A7 | Given CSV 导入 --run-analysis When 评分超阈值 Then 任务转 MANUAL（CSV 路径） | `test_csv_import.py::test_analysis_high_score_to_manual` |

**规则覆盖矩阵**（—=无覆盖）：

| 规则 | A1 | A2 | A3 | A4 | A5 | A6 | A7 | 缺口 |
|---|---|---|---|---|---|---|---|---|
| B1 输入契约 | | | | ✓ | | | | B1-3 截断 / B1-4 无方案占位：`test_scoring.py::test_scoring_prompt_truncates_plan_summary` / `test_scoring_prompt_placeholder_when_no_plan` |
| B2 LLM 行为 | ✓ | ✓ | | | | | | B2-1/B2-4 属模板事实，无自动化校验（设计性缺口） |
| B3 边界重试 | | | | | | | | `test_scoring.py::test_out_of_range_score_retries_then_failed` |
| B4 权重/策略 | | | ✓ | | ✓ | | | B4-2 部分合并：`test_scoring.py::test_strategy_partial_merge_keeps_config_defaults` |
| B5 合成准入 | ✓ | ✓ | ✓ | | ✓ | | ✓ | B5-2 developer 通知：`test_scoring.py::test_high_score_notifies_developer_with_score_detail` |
| B6 消费路径 | | | | | | ✓ | ✓ | admission_hold 审计：`test_scoring.py::test_preprocessing_hold_writes_admission_hold_audit` |

## 8. 演进：评分机制 v2（本地评价标准模板 + AI 多维分析 + 本地加权）

> 状态：**已实现**（`scoring_engine=v2` 开启；默认仍为 v1 照 as-built 运行，双引擎并存）。
> 实现落点：`prompts/rubrics/scoring_rubric_v1.md` + `prompts/rubric.py` 加载器、
> `prompts/templates/scoring_v2_v2.md` 薄壳（v2：判定流程分步+证据引用）、`各阶段包 schemas.py::JudgmentForm`、
> `scoring/v2.py` 本地映射器与代码实证检索、`stages/scoring.py::_run_v2`
> 四键权重（`SCORE_V2_WEIGHT_*`，0.3/0.3/0.2/0.2）、`code_evidence_v2` 模板。

### 8.1 v1 的结构性问题

v1 把"测量"也交给了 LLM——直接让它报 0-100 分数，模板无锚点、无样例、无温度控制。后果：**尺子在模型手里**，同一 bug 重跑分数可漂移，阈值附近的任务会在 FIXING/MANUAL 之间翻转；换模型版本约等于换一把尺子，阈值需重调；可解释性只剩一段可为空的自由文本 rationale。

### 8.2 v2 总体链路

```
本地评价标准模板（Markdown 表格，版本化）
   ↓ 运行时注入 prompt（原文直传）
AI 按标准逐项判定：归类 bug 类型 + 判定命中因子（+ 复杂类型触发代码实证）
   ↓ 输出"判定表单"（引用标准条目 ID，不输出分数）
本地常量映射器：类型基准 + 因子修正 → 四维分
   ↓
策略版本加权 → 阈值准入（沿用现有 strategy_version 与判定语义）
```

**LLM 全程不产出任何分数**：它只做归类与证据判定（擅长），测量（分数映射）由本地版本化规则完成。

### 8.3 本地评价标准模板（Markdown 表格，`prompts/rubrics/scoring_rubric_vN.md`）

标准不内嵌死在 prompt 模板正文，而是独立文件、版本化治理。格式示例（节选）：

```markdown
# 评分评价标准 rubric_version: v1

## 缺陷类型先验表
| 类型 ID | 名称 | 判定特征 | 修改难度基准 | 波及面基准 |
|---|---|---|---|---|
| copy_text | 文案/提示 | 提示语错误、UI 文案、日志措辞 | 5-15 | 5-10 |
| param_check | 参数校验/边界 | 入参未校验、空值/边界未处理 | 15-30 | 10-20 |
| single_logic | 单点逻辑 | 单函数内计算/分支/状态错误 | 30-55 | 15-35 |
| cross_module | 跨模块交互 | 契约不一致、状态同步、时序 | 55-75 | 40-70 |
| data_arch | 数据/架构 | schema 变更、数据迁移、性能架构 | 75-95 | 60-90 |

## 修正因子表
| 因子 ID | 判定者 | 判定问题/规则 | 影响维度 | 修正 |
|---|---|---|---|---|
| repro_executable | ai | 复现步骤是否可直接执行 | 修改 | -5 |
| desc_has_stack | ai | 描述是否含代码位置/堆栈 | 定位 | -10 |
| modules_ge_2 | local | affected_modules ≥ 2 | 波及 | +15 |
| plan_db_or_5steps | local | 方案含 query_db/assert_db 或 ≥5 步 | 验证 | +15 |

## 定位难度基准表
| 证据情况 | 基准 |
|---|---|
| 含堆栈/明确代码位置 | 10-20 |
| 有现象描述可推断 | 40-60 |
| 仅现象无位置线索 | 65-85 |

## 验证难度基准表
| 方案步骤数 | 基准 |
|---|---|
| <3 步且无 DB 断言 | 10 |
| 3-5 步 | 25 |
| >5 步或含 DB 断言 | 40 |
```

- **解析约定**：固定表头 + 固定列序，加载器按表头识别段落；首行 `rubric_version` 为版本标识
- **注入**：`scoring_v2_v2.md`（模板名 `scoring_v2`）只保留薄壳（角色 + "按以下评价标准逐项判定" + `{rubric_block}` + bug 数据 + 输出格式），标准原文直传；**标准变更只改 rubric 文件，不动模板结构**
- **治理**：与 strategy_version 同款通道——`optimization` 介入单可提议 rubric 变更（附依据，如"param_check 区间 15-30 收窄为 15-25，依据近 30 天该类通过率"），人批准后新版本激活，可回退

### 8.4 新维度体系：定位/修改/验证/波及（重构，四维）

| 维度 | 键名 | 数据源 |
|---|---|---|
| 定位难度 | `locate` | 描述证据质量（堆栈/位置线索）+ 代码实证结果 |
| 修改难度 | `fix` | 类型先验表 + 修改类因子 |
| 验证难度 | `verify` | 方案复杂度（本地推导：步骤数/动作类型）+ 验证类因子 |
| 波及面 | `blast` | 类型先验表 + 模块数/实证涉及文件数 |

合成：`total = round(Σ dim×w_dim, 2)`，准入语义不变（严格小于准入）。

**兼容迁移点（实现时处理）**：strategy_version 权重从三键 `{fix, verify, change}` 变四键 `{locate, fix, verify, blast}`——v2 上线需经 optimization 介入单生成四键新策略版本（沿用部分合并逻辑时旧三键策略无法完整驱动 v2）；历史 score_detail 保留旧结构不迁移；调度排序仍用 priority_score 单值，不受影响。默认四维权重待定（建议起点 0.3/0.3/0.2/0.2，经评审定）。

### 8.5 AI 判定表单（v2 输出契约，替代 ScoreOutput）

```json
{
  "bug_type": "param_check",
  "type_evidence": "标题含'未校验'，复现步骤给出空值输入触发 400",
  "factors_hit": ["repro_executable"],
  "factor_evidence": {"repro_executable": "步骤 1-3 给出具体入参与接口路径"},
  "locate_signals": {"has_stack": false, "has_location_desc": true},
  "code_evidence": {"triggered": false}
}
```

每个分数可反推到"哪个类型区间 + 命中哪些因子"——评分争议时可指出具体判错的那一项，替代 v1 不可校验的自由文本 rationale。

### 8.6 代码实证（复杂类型触发）与仓库前置要求

- **触发**：AI 归类为 `cross_module`/`data_arch` 时，第二次 LLM 调用——输入 = bug 块 + 按标题/堆栈/关键词从**全部关联仓库**（Spec 01 §9）**只读检索**的相关文件片段（不建工作区，token 限量：每文件首命中行、<=8 片段、跳过二进制/git 目录），产出实证结论（是否定位到疑似问题点、涉及文件数、改动面估计），驱动定位/波及维度（triggered -> 定位 -10；suspected_files 每文件波及 +5、上限 +20）
- **仓库可用性前置**：**不允许"复杂类型但无仓库"的降级路径**——代码仓库要求已前置到接入层（Spec 01 §9：接入时关联全部修复涉及仓库并逐个校验可用性，缺失/不可用停 `WAIT_INFO` 并主动询问补全，P1 待实现）。scoring 层默认仓库可用，实证无条件可触发，不存在"无实证按中点降级"分支
- 安全：实证检索只读，不进入修复工作区，不触碰修复链路的写权限

### 8.7 实现触点

1. `prompts/rubrics/scoring_rubric_v1.md` + 加载器（表头解析、版本读取）
2. `prompts/templates/scoring_v2_v2.md`（薄壳 + `{rubric_block}` 占位符）
3. `各阶段包 schemas.py`：判定表单 Schema（替代/并存 ScoreOutput）
4. `stages/scoring.py`：本地映射器（基准+因子→四维分）、代码实证分支
5. `strategy_version`：四键权重 + optimization 介入单提议 rubric 变更
6. `score_detail`：增记 `rubric_version`、`bug_type`、`factors_hit`
7. 测试：映射器单测（纯本地可全确定性）、判定表单 Schema 校验、实证触发条件
8. 方案 `fix_approach` 注入（Spec 03 §9.4 P1：修复思路大纲作为修复难度/改动面判断依据，随 bug 块注入评分 prompt）

### 8.8 决策记录（2025 本次走查确认）

| 决策点 | 结论 |
|---|---|
| 节奏 | 先进 spec（本节），实现另行排期 |
| 无仓库复杂类型 | 不允许降级；仓库要求前置到接入层（已写入 Spec 01 §9，P1 待实现） |
| 维度 | 重构为定位/修改/验证/波及四维 |
| 标准模板格式 | Markdown 表格（人读友好，AI 注入原文直传） |

## 9. 已知限制和范围外

- ~~**v1 打分无锚点/未校准**~~（v2 已实现：rubric 锚点 + 本地映射，`scoring_engine=v2` 切换；v1 保留为缺省兼容路径）
- `rationale` 允许为空且无质量校验（v2 已由判定表单证据替代；v1 路径仍在）
- 权重和不强制为 1（配置责任）
- 评分不含历史通过率反馈信号（P2 可结合经验库命中率修正难度先验；v2 的 rubric 治理通道已为其预留入口）
- ~~developer 通知与 admission_hold 审计无测试断言~~（已补齐，见 §7 矩阵缺口列）
- LLM 网关重试不分类异常（认证错误也会重试 3 次）——与 Spec 02 B0 遗留优化项相同
- 范围外：调度器整体行为（出队上限调优、SLA 扫描）见调度相关设计；策略建议生成算法（optimization 服务）仅在 B4-4 引用
