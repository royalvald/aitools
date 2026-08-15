# Spec 03 · 验证方案生成（第一阶段）

| 项 | 值 |
|---|---|
| 范围 | **仅验证方案生成阶段**：LLM 产出 DSL 结构化方案 + 风险分级 + 高风险人工确认（评分见 Spec 04，DSL 执行见 Spec 07） |
| 源码 | `pipeline/stages/planning.py`（阶段逻辑）、`pipeline/dsl.py`（DSL 词表与校验）、`services/intervention.py`（确认回写） |
| 提示词 | `prompts/templates/planning_v1.md`（占位符 `{bug_block}`）；P1 演进 `planning_v2`（四段式 + 修复思路大纲，见 §9） |
| 参考样例 | `examples/bugs_sample.csv`（CSV 路径恒低风险，落点可复现） |

## 1. 目标与结果预期

让 LLM 基于 Bug 信息产出**结构化、可执行**的回归验证方案，并以受限 DSL 杜绝自由文本方案；命中高风险模块必须经技术负责人确认。

| # | 预期 | 验证方式 |
|---|---|---|
| R1 | 每个进入本阶段的任务恰好产出 1 份方案，步骤全部在 9 动作词表内且必填参数齐全（生成期 Schema 拦截 + 重试） | `verification_plan` 落库 + 审计 `llm_call` |
| R2 | 方案版本化：首版 `version=1, dsl_version="1.0"`；人工调整后 `version+1`；验证阶段**始终执行最新版本** | `version` 字段 + 验证记录 `plan_version` |
| R3 | 低风险（影响模块 ∩ 高风险清单 = ∅）**自动通过**进 `SCORED`，零人工介入 | 任务状态 + 无介入单 |
| R4 | 高风险（交集非空）必经确认：`WAIT_PLAN` 阻塞 + `plan_confirm` 介入单通知 tech_lead（context 携带 plan_id / steps / 命中模块） | 介入单 + 状态历史 |
| R5 | 确认回写三分支：原样批准 → `SCORED`；批准+调整 → steps 覆盖 + `version+1` + confirmed_by/at 落库；**拒绝分支存在已知缺陷（见 B6 ⚠️）** | 介入单 result + plan 字段 |
| R6 | CSV 路径（无影响模块列）**恒为低风险**，本阶段永不阻塞 | 导入分析端到端 |

## 2. 输入契约与状态流转

**输入**：

- 任务状态 `PLANNING`（由 Spec 02 完整性评估通过迁入）；
- `ctx.bug`：BugTicket 全字段（`affected_modules` 为风险判据，来自平台侧字段——mock/Jira/禅道有此字段，**CSV 无此列恒为空列表**）；
- 配置 `HIGH_RISK_MODULES`（默认 `["core-payment", "auth"]`）；
- 前置条件：LLM 网关可用性由启动点预检保证（Spec 02 B0）。

**LLM 输出 Schema（`PlanOutput`）**：

```json
{
  "env_requirements": "环境要求描述（如：本地仿真环境）",
  "steps": [{"action": "call_api", "params": {"method": "GET", "path": "/health"}, "desc": "调用健康检查接口"}],
  "expected_results": ["status 字段为 ok"],
  "function_points": ["健康检查接口"],
  "regression_scope": "接口回归"
}
```

五字段去向：`steps` 是**唯一被机器执行**的字段；其余四个（env_requirements / expected_results / function_points / regression_scope）供人工确认展示与审计留痕，不参与执行。（P1 新增第六字段 `fix_approach` 修复思路大纲，供评分与修复阶段消费，见 §9.4。）

**状态流转（按场景标注，每个状态附含义）**：

```
场景A 低风险（BUG-2001/2003/2004，CSV 路径恒走此场景）：
  PLANNING(执行态：本阶段运行中) ──success──▶ SCORED(执行态：难度评分入队，见 Spec 04)

场景B 高风险（影响模块命中 core-payment/auth 等清单项）：
  PLANNING(执行态) ──need_intervention──▶ WAIT_PLAN(阻塞态：等 tech_lead 确认方案，
      创建 plan_confirm 介入单并通知 tech_lead)
      回写① approved=false              → ⚠️ 已知缺陷，见 B6
      回写② approved=true（原样批准）   → SCORED（按原方案进入评分）
      回写③ approved=true + steps       → SCORED（按人工调整版执行，version+1）
  （回写入口均为 API POST /interventions/{id}/resolve）

场景C LLM 输出非法/预算超限/未捕获异常：
  PLANNING(执行态) ──异常──▶ FAILED(可续跑态：故障排除后重新触发，从本阶段继续)
```

## 3. 行为规格

### B1 方案生成（1 次 LLM 调用）

| 规则 | 环节 | 规格 |
|---|---|---|
| B1-1 | Prompt | `planning_v1` 模板填充 `{bug_block}`（七行结构化文本，注入防护同 Spec 02 B2-5：检测留痕 + `<untrusted_bug_data>` 包裹） |
| B1-2 | 评估任务（模板原文口径） | 角色"测试设计助手"，任务"基于 Bug 信息生成可执行的回归验证方案"；模板内嵌**完整 DSL 词表**并明示"禁止词表外动作" |
| B1-3 | 调用 | `ctx.llm.analyze(prompt, PlanOutput)` 恰 1 次（不含校验失败重试）；预算/计量/审计口径同 Spec 02 B2-6/B2-7 |
| B1-4 | 结构化校验 | `steps` 逐条过 `DSLStep` 校验（词表 + 必填参数，见 B2）；失败由 Gateway 重试（`stage_max_retry`=2），耗尽 → `FAILED` |

> **as-built 事实（方案深度零要求）**：`planning_v1` 对步骤组织的全部指示是"生成可执行的回归验证方案"+ 词表——无流程结构、无步数下限、无断言覆盖要求；`steps` Schema 无最小数量（`[]` 可落库，见 §5 空步骤行）。Fake 应答即最薄形态（`call_api` + `assert_response` 共 2 步，单接口单断言）。目标深度要求（四段式流程 + 修复思路大纲）见 **§9（P1）**。

### B2 DSL 词表（9 动作，双保险约束）

**生成期**（本阶段）：`DSLStep` pydantic 校验——动作必须在词表内、`params` 覆盖必填参数，否则触发 LLM 重试。
**执行期**（Spec 07）：解释器对每条步骤再校验一次并检查 handler 存在——生成期漏网的非法动作在执行期被拒（双保险）。
**注意**：`query_db / assert_db` 的**只读 SELECT 约束在执行期**强制（生成期不校验 sql 内容）。

| 动作 | 必填参数 | 可选参数 | 类别 |
|---|---|---|---|
| `open_page` | `url` | — | 页面 |
| `click` | `selector` | — | 页面 |
| `input` | `selector, value` | — | 页面 |
| `assert_element` | `selector, state` | — | 页面（state 值域 `present / absent / text:xxx`） |
| `call_api` | `method, path` | `body, headers` | 接口 |
| `assert_response` | `expect` | `status, json_path` | 接口 |
| `query_db` | `sql` | — | 数据（执行期强制只读 SELECT） |
| `assert_db` | `sql, expect` | — | 数据（expect 形式 `row_count>=1` 或 `field=value`） |
| `check_log` | `service, pattern` | `since` | 日志 |

（`desc` 为全部动作的可选可读描述，人工确认介入单展示用。）

> 词表当前为**固定 9 动作**；组合式扩展机制（AI 自主技能沉淀，P1）见 §8。

### B3 风险分级

| 规则 | 规格 |
|---|---|
| B3-1 | `hit_risk = sorted(set(bug.affected_modules) ∩ set(settings.high_risk_modules))`——集合交、去重、排序（输出确定性） |
| B3-2 | `hit_risk` 非空 → `risk_level="high"`；为空 → `"low"` |
| B3-3 | 判据**只看 affected_modules 字段**，与方案内容（步骤/动作类型）无关——方案里全是 query_db 也可能是 low risk |
| B3-4 | CSV 数据源无影响模块列 → `affected_modules=[]` → 恒为 low（R6） |

### B4 落库与审计

| 规则 | 环节 | 规格 |
|---|---|---|
| B4-1 | 落库 | `VerificationPlan(task_id, dsl_version="1.0", env_requirements, steps, expected_results, function_points, regression_scope, risk_level)`，首版 `version=1` |
| B4-2 | 审计 | `llm_call`：stage=planning、prompt_version、**plan_id**、risk_level |

### B5 分流与介入单

| 规则 | 输入 | 预期结果 |
|---|---|---|
| B5-1 | risk_level=low | `success` → `SCORED`，message="低风险方案自动通过"，artifacts 携带 plan_id |
| B5-2 | risk_level=high | `need_intervention` → 创建下表介入单 → `WAIT_PLAN` |

**plan_confirm 介入单规格**：

| 字段 | 值 |
|---|---|
| type / assignee_role | `plan_confirm` / `tech_lead`（通知技术负责人） |
| wait_state | `WAIT_PLAN` |
| title | `Bug {platform_bug_id} 验证方案待确认（命中高风险模块: [core-payment]）` |
| context | `{plan_id, steps（完整 DSL 步骤，供审阅）, hit_risk_modules}` |
| status | 创建即 `pending`；无 deadline，超时升级走调度器 SLA 扫描 |

### B6 确认回写（`POST /interventions/{id}/resolve`，result 约定 `{"approved": bool, "steps"?: [...]}`）

| 规则 | 回写内容 | 预期结果 |
|---|---|---|
| B6-1 | `approved=true`（无 steps 或 steps 为空列表） | plan 写 `confirmed_by=actor`、`confirmed_at`；介入单 resolved；`WAIT_PLAN → SCORED`（"方案已确认，进入评分"） |
| B6-2 | `approved=true` 且 steps **非空** | 在 B6-1 基础上：`plan.steps = result["steps"]`、`plan.version += 1`（人工调整留版本痕迹）；验证阶段按新版本执行 |
| B6-3 | `approved=false` | ⚠️ **已知缺陷，当前必然失败**，详见下框 |

> ### ⚠️ 已知缺陷（2025-06 走查发现，未修复）
>
> **B6-3 拒绝分支（approved=false）无法完成**：
>
> - 代码意图（`intervention.py`）：`WAIT_PLAN → MANUAL`（"方案未获确认，转人工处理"）；
> - 状态机表（`state.py`）：`WAIT_PLAN` 合法迁移集为 `{PLANNING, SCORED, CANCELLED}`，**不含 MANUAL**；
> - 后果：`assert_transition` 抛 `IllegalTransitionError` → 回写 API 500、事务回滚 → **介入单结不了案、任务永久卡在 WAIT_PLAN，拒绝操作无法完成**；
> - 旁证：同类阻塞态均支持转人工（`WAIT_DISCUSS → MANUAL`、`ANALYZING → MANUAL`），本条为状态机表遗漏；
> - 修复方向（待排期）：`LEGAL_TRANSITIONS[WAIT_PLAN]` 补 `MANUAL`，并补拒绝分支测试。

**回写口径补充**（B6-4）：回写**不校验** steps 内容（`plan.steps` 直接赋值）——人工调整若含非法动作/缺参，落库成功但在验证阶段执行时才报错（`FAILED`）。人工调整的 steps 应视为可信输入，但无 Schema 防线是客观事实，见 §8。

## 4. 样例文件预期落点

对 `examples/bugs_sample.csv` 执行导入 `--run-analysis`，本阶段各行行为：

| bug_id | 风险判定 | LLM 调用 | 落点 |
|---|---|---|---|
| BUG-2001 | CSV 无影响模块列 → low | 1 | **确定**：`SCORED`（方案 steps 内容由 LLM 决定） |
| BUG-2002 | — | 0 | **到不了本阶段**：卡在 Spec 02 的 WAIT_INFO（补齐唤醒后进入，届时同样恒 low） |
| BUG-2003 | low | 1 | `SCORED` |
| BUG-2004 | low | 1 | `SCORED` |

高风险场景无法由 CSV 样例触发（无影响模块列）——需 mock/Jira/禅道数据源携带 `affected_modules=["core-payment"]` 类字段，当前**无自动化测试覆盖**（见 §7）。

## 5. 异常场景表

| 场景 | 输入 | 行为 | 预期结果 |
|---|---|---|---|
| 词表外动作 | LLM 输出 `action: "restart_service"` | `DSLStep` 校验失败 → Gateway 重试 | 重试耗尽 → `FAILED`；重试成功则正常落库 |
| 缺必填参数 | `call_api` 缺 `path` | 同上（params 校验失败） | 同上 |
| 空步骤方案 | LLM 输出 `steps: []` | **Schema 放行**（无最小数量约束） | 方案落库；验证阶段 0 步全过（空真），直接判通过——P1 由 §9.2 硬校验解决 |
| 步数不足（P1） | LLM 输出 steps < 3 或无 `assert_*` 动作 | §9.2 Schema 校验失败 → Gateway 重试（B1-4 同机制） | 重试耗尽 → `FAILED` |
| 人工调整含非法步骤 | 回写 steps 带词表外动作 | 回写不校验，落库成功 | 验证阶段执行时报错 → `FAILED`（B6-4） |
| 预算超限 | token 额度用尽 | 调用前拦截 | `FAILED` 断点续跑 |
| 注入命中 | Bug 文本含注入模式 | 留痕不阻断 | 审计 `injection_detected`，评估照常 |
| 回写已处理介入单 | resolve 非 pending 单 | 抛 `ValueError` | 幂等保护，任务不动 |
| **拒绝回写** | `approved=false` | **抛 `IllegalTransitionError`（已知缺陷 B6-3）** | API 500、事务回滚、任务卡死 WAIT_PLAN |

## 6. 数据与审计留痕

| 表/审计 | 写入时机 | 关键内容 |
|---|---|---|
| `verification_plan` | B4 生成 / B6-2 调整 | steps、risk_level、version、dsl_version、confirmed_by/at |
| `task` + `task_state_history` | B5 分流 / B6 回写 | state、迁移 stage 与 message |
| `intervention` | B5-2 创建 / B6 结案 | type=plan_confirm、context（plan_id/steps/hit_risk_modules）、result、actor |
| 审计 `llm_call` | B4-2 | stage、prompt_version、plan_id、risk_level |
| `llm_usage` | B1-3 | token 计量（预算口径） |

## 7. 验收条款

| # | 条款（Given/When/Then） | 测试 |
|---|---|---|
| A1 | 给定低风险任务（CSV 路径），当方案生成，则 risk_level=low、自动通过进 SCORED 且方案已落库 | `test_import_and_analysis_end_to_end` |
| A2 | 给定状态机迁移表，当查询，则 PLANNING→WAIT_PLAN、WAIT_PLAN→SCORED 为合法迁移 | `test_state_machine.py`（迁移对参数化） |
| A3 | 给定高风险任务（affected_modules 含 core-payment），当方案生成，则产生 plan_confirm 介入单、任务停 WAIT_PLAN | **无覆盖**（待补，见下） |
| A4 | 给定 WAIT_PLAN 介入单，当回写 approved=true，则 confirmed_by 落库、任务进 SCORED | **无覆盖**（待补） |
| A5 | 给定 WAIT_PLAN 介入单，当回写 approved=true+steps，则 plan.version+1、steps 被覆盖、按新版本执行 | **无覆盖**（待补） |
| A6 | 给定 WAIT_PLAN 介入单，当回写 approved=false，则任务转 MANUAL | **不可验收**——当前因 B6-3 缺陷必然失败，修复后补 |

**规则覆盖对照**（规则 ↔ 测试，标注缺口）：

| 规则 | 自动化测试 | 缺口 |
|---|---|---|
| B1/B4 生成与落库（低风险路径） | A1（端到端间接覆盖） | — |
| B2 词表校验（生成期拦截重试） | 无直接单测 | 可补：非法动作/缺参构造断言重试与 FAILED |
| B3-4 CSV 恒低风险 | A1（risk_level=="low" 断言） | — |
| B5-2 高风险阻塞 | 无 | 高风险端到端（A3） |
| B6-1/B6-2 批准与调整回写 | 无 | A4/A5 |
| B6-3 拒绝回写 | 无 | **被缺陷阻断**，修复后补 A6 |
| 空步骤方案（§5） | 无 | 可补：steps=[] 断言空真通过（固化现状或先加约束） |

## 8. DSL 扩展机制（P1 演进设计：AI 自主技能扩展）

**定位**：验证能力随使用自我增长——AI 在方案生成中把有价值的组合校验沉淀为可复用**技能**（命名 + 参数化的步骤模板），后续方案直接引用。全部技能由 9 基础动作组合而成，**不引入新原子动作**，既有安全防线完整保留。

| 环节 | 设计 |
|---|---|
| 技能形态 | `name + 参数签名 + desc + 步骤模板`（模板仅含 9 基础动作，支持 `{param}` 占位，如 `input(selector=#user, value={user})`） |
| 提议 | 方案生成时 LLM 可在输出中携带 `proposed_skills`：当基础动作单步/直排表达不了某个校验过程（如"登录冒烟检查"五步套路）时组合提出 |
| 首次使用 | 提议技能**仅内联展开**落库（本方案逐步骤可见可执行），**不进技能库**——零治理成本，先在本任务验证好不好用 |
| 入库沉淀 | 验证通过后由学习阶段（与 Spec 08 修复经验同机制）蒸馏入库：去重合并、upsert、记录来源任务与使用统计——**技能库 = 验证侧经验库** |
| 复用 | `planning_v1` 模板增加 `{skill_library}` 动态段，渲染当前可用技能清单（名称/参数签名/描述）；LLM 引用技能名 + 实参生成步骤 |
| 落库口径 | 引用技能的方案保存时**展开为原始步骤**存入 `verification_plan`——执行与技能库后续变更完全解耦（已落库方案不受技能演化影响） |
| 安全 | 展开后仍是 9 动作：只读 SELECT、词表校验、双保险、高风险人工确认（确认单展示展开步骤）**全部照常生效**——扩展只提升表达效率，不扩大能力边界 |
| 治理 | 技能入库/引用写审计；技能条目带版本与使用统计；控制台查看/停用技能为 P2 管理界面 |

**实现联动点**（排期时一并处理）：

- `planning_v1.md`：词表段后增加 `{skill_library}` 占位符（模板从静态词表变为"静态词表 + 动态技能"两段渲染）；
- `PlanOutput` schema：增加可选 `proposed_skills` 字段（模板步骤同样过 DSLStep 词表/必填参数校验链）；
- 学习阶段（Spec 08）：增加技能蒸馏 upsert 分支；
- 新表 `verification_skill`（或经验表加类型字段）：名称/参数/模板/版本/使用统计。

**明确不做（P2+ 按需评估）**：

- 新**原子**动作注册——需 `DSL_ACTIONS` 运行时注册表、解释器 handler 插件化、plan 落库词表指纹三处联动，且引入用户代码进执行链的安全面；待出现基础动作真正表达不了的动作需求再付此成本；
- 配置文件 / API 人工注册通道——与"AI 自主沉淀"定位不符；人工维护的固定套路由数据源模板或后续控制台管理承接。

## 9. 方案深度要求（P1 目标规格 · 待实现）

> 状态：**目标规格，当前未实现**。由走查确认：as-built 对"方案要多详细"零要求（见 B1 注记），单动作/一句话方案可合格落库。本节定义方案的目标形态：**四段式操作执行流程 + 修复思路大纲**。

### 9.1 要求总则

| # | 要求 | 动机 |
|---|---|---|
| 1 | `steps` 必须构成完整操作执行流程（四段式，§9.2），而非单一动作直排 | 真实回归验证必然是"准备→触发→断言→交叉"的多步链 |
| 2 | 流程中至少 1 条断言动作，且断言前必须有触发动作 | 无断言的验证不构成验证；无触发的断言验证的是旧状态 |
| 3 | 方案必须携带 `fix_approach` 修复思路大纲（§9.4） | 评分与修复阶段消费，修复不再零上下文冷启动 |
| 4 | 深度要求由 Schema 硬校验（生成期重试兜底）+ 模板引导（生成质量）双层保证 | 硬校验保下限，引导提上限 |

### 9.2 四段式流程结构（steps 组织规格）

| 段 | 职责 | 典型动作 | 步数要求 |
|---|---|---|---|
| S1 前置准备 | 构造验证前置状态：查/造前置数据、打开页面、登录 | `query_db` / `open_page` / `input` / `click` | ≥1 |
| S2 触发执行 | 触发被验证的目标行为 | `call_api` / `click` / `open_page` | ≥1 |
| S3 结果断言 | 验证行为的直接结果 | `assert_response` / `assert_element` | ≥1 |
| S4 交叉验证 | 数据核对 / 日志检查（涉及数据变更或服务行为时） | `assert_db` / `check_log` | 适用时 ≥1 |

**Schema 硬校验**（生成期，违规走 B1-4 既有重试链，3 次耗尽 → `FAILED`）：

- `steps` 数量 ≥ 3（S1-S3 各至少 1 步的下限表达）；
- 至少 1 条 `assert_*` 动作（`assert_response` / `assert_element` / `assert_db` 任一）；
- S4 的适用性（bug 是否涉及数据变更/服务行为）**由模板引导 LLM 判断，不做硬校验**——避免强行凑步。

### 9.3 check_log 否定断言（absent 参数）

as-built：`check_log` 的通过条件是**命中数 > 0**（`dsl.py`：`ok = len(matched) > 0`），只能表达"存在预期日志"，无法表达"日志中**不出现** ERROR"类否定断言。

P1：增加可选参数 `absent`（bool，缺省 `false`）——`absent=true` 时通过条件反转为**命中数 == 0**。向后兼容：既有方案缺省行为不变。

### 9.4 fix_approach 修复思路大纲（PlanOutput 新字段）

```json
{"locate_hints": ["堆栈指向 api/health.py:42", "服务注册表查询无降级分支"],
 "change_files": ["api/health.py"],
 "strategy": "健康检查读取注册表失败时降级返回 unknown 而非 fail"}
```

| 字段 | 内容 |
|---|---|
| `locate_hints` | 可疑点定位线索（堆栈指向/可疑模块/可疑接口） |
| `change_files` | 拟改动文件/模块清单 |
| `strategy` | 修复策略概述（怎么改、为什么这样改） |

**消费方**：

1. **Spec 04 评分**：修复难度/改动面判断多一层依据（v2 判定表单可引用，见 Spec 04 §8.7 触点 8）；
2. **Spec 05 修复**：首轮修复提示注入 `fix_approach`——修复阶段不再零上下文冷启动；**大纲是提示不是约束**，修复中可依实际代码偏离。

**落库**：`verification_plan` 增加 `fix_approach` JSON 列（随 plan 版本化，人工调整回写不含此字段）。

### 9.5 模板与样例（planning_v2）

`planning_v2.md` 相对 v1 的变化：词表段后增加四段式结构说明（§9.2 表格）+ 一条完整示例 + `fix_approach` 输出要求；`prompt_version` 记录 `planning_v2`。

**示例：BUG-2001（健康检查接口返回 fail）目标五步链**：

| 段 | 步骤 | DSL |
|---|---|---|
| S1 前置 | 查服务注册表有存活实例 | `query_db: select count(*) as n from service_registry where status='up'` |
| S2 触发 | 调健康检查接口 | `call_api GET /health` |
| S3 断言 | 响应 status=ok | `assert_response json_path=status expect=ok` |
| S4 数据交叉 | 健康检查表最新记录为 ok | `assert_db: select status from health_check order by checked_at desc limit 1, expect=status=ok` |
| S4 日志交叉 | 存在健康检查访问日志、无健康检查报错 | `check_log service=app pattern=GET /health 200`；§9.3 落地后可加 `check_log service=app pattern=ERROR.*health, absent=true` |

### 9.6 实现触点

| 触点 | 改动 |
|---|---|
| `prompts/templates/planning_v2.md` | 四段式说明 + 完整示例 + fix_approach 要求（§9.5） |
| `pipeline/schemas.py` PlanOutput | steps 校验器（≥3 且含 assert_*，§9.2）+ `fix_approach` 字段 |
| `models.py` VerificationPlan | `fix_approach` JSON 列 |
| `pipeline/dsl.py` check_log | `absent` 可选参数（§9.3） |
| `llm_gateway.py` Fake 应答 | **同步升级为四段式五步方案**——否则新校验直接打回 Fake 2 步应答，现有测试全红 |
| Spec 04 评分 prompt | 注入 fix_approach（v2 实现时，见 Spec 04 §8.7 触点 8） |
| Spec 05 fixing prompt | 首轮注入 fix_approach |

### 9.7 决策记录（本次走查确认）

| 决策点 | 结论 |
|---|---|
| 流程结构 | 四段式（前置准备/触发执行/结果断言/交叉验证）；S1-S3 硬校验（steps ≥3 + 含 assert_*），S4 适用性模板引导不硬校验 |
| 修复思路 | 方案携带 fix_approach 大纲（定位线索/拟改动文件/策略概述），供评分与 Fixing 首轮消费；修复允许实际偏离大纲 |
| check_log 表达力 | 加 absent 可选参数支持否定断言，缺省行为不变（向后兼容） |

## 10. 已知缺陷与范围外（演进项）

**待修复缺陷**：B6-3 拒绝回写 `IllegalTransitionError`（修复方向见 §3 框注；建议与 A3-A6 测试缺口一并处理）。

范围外：

- 生成期 sql 只读校验（当前只读约束全部在执行期，见 B2）；
- steps 最小数量约束（空步骤方案空真通过，见 §5）——**P1 已设计解决（§9.2 硬校验），实现后本项移除**；
- 页面类动作真实浏览器执行（词表已含，执行侧当前为本地仿真模拟，P1 接 Playwright，详见 Spec 07）；
- 性能/压测类验证动作（词表扩展路径见 §8：原子动作注册为 P2+）；
- 人工调整 steps 的回写期校验（当前执行期兜底，见 B6-4）。
