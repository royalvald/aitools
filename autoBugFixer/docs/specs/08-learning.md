# Spec 08 · 经验沉淀与关闭（Learning）

| 项 | 值 |
|---|---|
| 涉及状态 | `LEARNING`（执行态）→ `CLOSED`（终态）或 `WAIT_DISCUSS`（阻塞态） |
| 源码 | `learning/stage.py`、`knowledge/experience.py`、`platform/writeback.py`、`intervention/service.py`、`core/llm.py`、`runtime/orchestrator.py` |
| 提示词 | `prompts/templates/failure_analysis_v2.md`（v2：失败模式归类+condition_desc 可判定；四占位符 `bug_block` / `retry_count` / `max_retry` / `failed_steps`） |
| 需求 | FR-MEM-01（经验入库与去重）、FR-MEM-02（不适用场景与人工讨论）、11.7（平台回写） |
| 上游 / 下游 | 回归验证通过或耗尽（Spec 07）、修复相同 diff 提前终止（Spec 05 §5 校验 3）→ 终态 `CLOSED`；或讨论回写 `MANUAL / CLOSED / FIXING` |
| 介入类型 | `discussion`（指派 `developer`） |

## 1. 目标

流水线的**收口阶段**，只回答两个问题：**"bug 修好了，系统学到什么、要通知谁？"** 和 **"修不好，怎么体面地交给人？"** 对应两条路：

- **修好了（验证通过）**：把这次"什么症状 → 怎么修的 → 怎么验证的"存进经验库（下次同类 bug 修复时 AI 能查到参考，见 §3.6）→ 通知测试人员"已自动修复" → 给 Jira/禅道回写"已关闭" → 任务终态 `CLOSED`，自动收尾。
- **修不好（重试耗尽 / 修复原地打转）**：让 LLM 复盘"为什么修不动"生成一段**不适用场景**描述（LLM 挂了就用规则模板顶上，绝不卡住）→ 存档 → 给开发人员发一张**"待讨论"工单**，任务停在 `WAIT_DISCUSS` 等人拍板，三个选项：人工修（`MANUAL`）/ 强制关单（`CLOSED`）/ 再给机器一次机会（`FIXING`，重试计数清零）。

**具体例子（BUG-T001 两条路各自产出什么）**：

修好 → 经验库多出一行（或同键合并 version+1）：

```json
{"category": "接口类",                          // 标题含"接口"命中分类第一级
 "problem_signature": "健康检查接口返回 fail",   // = bug 标题（去重键成分）
 "symptoms": "status 为 fail",                  // = bug 实际结果
 "fix_pattern": "修复完成：已将 status 修正为 ok。",  // = 修复 agent 的总结
 "verification_points": "调用健康检查接口; 断言 status 为 ok",
 "applicable_conditions": "env=v1.0.0", "version": 1, "hit_count": 0}
```

同时：测试人员收到通知"Bug BUG-T001 已自动修复关闭"；Jira 单状态被回写为"已关闭"；任务进 `CLOSED`。

修不好 → 多一条不适用场景存档（如"重试 3 次仍未通过验证，失败步骤: [assert_response]"）+ 一张讨论工单（标题"Bug BUG-T001 修复失败待讨论"），任务挂起 `WAIT_DISCUSS`，直到有人回写三个选项之一。

本阶段与 Spec 05 §4 的经验注入共同构成**自我改进回路**（这边存、那边取）。主线为双分支执行全过程时序（§2），其后是六套机制小节（§3）。

| # | 预期 | 验证方式 |
|---|---|---|
| R1 | 分流判定只依赖最新 VerifyRecord（attempt 最大者）的 conclusion；无任何验证记录也安全落入失败分支不抛错 | `learning.py:29-35` + `test_failure_branch.py` |
| R2 | 成功路径产出一条去重合并的 Experience（同键重复 → version+1 而非新增），并通知 tester、回写平台"已关闭" | `test_e2e.py`、`test_experience_reuse.py::test_experience_upsert_dedup` |
| R3 | 失败路径必产出 InapplicableCase + discussion 介入单，且**LLM 故障不阻断**（异常吞掉 + 规则模板兜底） | `test_failure_branch.py::test_failure_branch_llm_analysis` |
| R4 | 讨论三回写（manual_fix/close/retry）分别迁移 MANUAL/CLOSED/FIXING，retry 重置 retry_count=0 | `test_failure_branch.py` 三用例 |
| R5 | 平台回写失败重试一次后仅审计+告警，**绝不阻塞**任务关闭 | `test_notifier_writeback.py::test_writeback_failure_not_blocking` |
| R6 | CLOSED 为终态：run_task 对终态短路返回 None | `orchestrator.py:176-177` + `test_e2e.py` |

## 2. 双分支执行全过程时序（主线）

### 2.0 分流判定（learning.py:29-35）

```
last_verify = select(VerifyRecord).where(task_id==task.id)
             .order_by(attempt.desc()) 的第一条
verified = last_verify 存在 且 last_verify.conclusion == "passed"
├─ verified → 成功分支（§2.1）
└─ 否则     → 失败分支（§2.2）
```

"否则"覆盖三种情况：conclusion=="failed"；**无任何 VerifyRecord**（修复阶段相同 diff 提前终止、从未进入验证——Spec 05 §5 校验 3 的出口）；结论值异常。

### 2.1 成功分支 trace（`_success_branch`，learning.py:39-60）

```
S1 素材选取
   fix   = 最新 FixRecord（attempt desc 第一条；修复必有记录，防御性兜底：
           fix 不存在时 fix_pattern 取空串）
   五个文本字段组装：
   · problem_signature   = bug.title（原样，去重键成分）
   · symptoms            = bug.actual[:500]
   · fix_pattern         = (fix.summary if fix else "")[:500]
   · verification_points = verify.step_results 全部步骤的
                           (desc 优先，缺则 action) 以 "; " 拼接后 [:500]
   · applicable_conditions = f"env={bug.env_version}"
   · root_cause_pattern = ""（恒空串，P1 LLM 归因占位）

S2 关键词分类（_classify，learning.py:110-122）
   text = f"{bug.title} {bug.description}"，五级优先级短路判定：
   1. 接口类：关键词 接口 / api / API / 请求
   2. 数据类：数据 / SQL / 库
   3. 界面类：页面 / 界面 / 按钮 / 显示
   4. 环境类：部署 / 环境 / 配置
   5. 其他（以上全不中）

S3 ExperienceService.upsert（去重算法见 §3.1）→ 经验落库/合并

S4 通知 tester（learning.py:56-58）
   NoticeMessage(title=f"Bug {platform_bug_id} 已自动修复关闭",
                 content=f"任务 #{task.id} 验证通过",
                 link=f"/tasks/{task.id}")

S5 StageResult(success, next_state=CLOSED) → Orchestrator._handle_result
   → _transition（orchestrator.py:116-141）：
   assert_transition 校验 + task.state=CLOSED + **task.closed_at=now**
   + TaskStateHistory + state_transition 审计
   + 平台回写钩子（§3.4）：CLOSED → "已关闭"

OUT-S：任务终态 CLOSED，run_task 后续调用直接返回 None
```

### 2.2 失败分支 trace（`_failure_branch` + 编排，learning.py:64-108 / orchestrator.py:149-152）

```
F1 failed_steps 构造（learning.py:65）
   verify 存在 → [s for s in verify.step_results if not s.get("passed")]
   verify 为 None（无验证记录）→ 空列表

F2 LLM 失败分析（调用链见 §3.2）
   prompt = failure_analysis_v2.format(
       bug_block=build_bug_block(ctx)（经 <untrusted_bug_data> 注入防护包裹）,
       retry_count=task.retry_count, max_retry=task.max_retry,
       failed_steps=json.dumps(failed_steps)[:1000])
   result = ctx.llm.analyze(prompt, FailureAnalysis, stage="learning", ...)
   · analyze 内部：预算前置检查 + (stage_max_retry+1) 次校验重试
   · learning 侧 try/except Exception → 返回空 FailureAnalysis()（三字段全空）

F3 规则模板兜底（空字段逐个 or，learning.py:69-76）
   condition_desc 或 f"模块 {affected_modules} / 环境 {env_version}"
   reason 或 f"重试 {retry_count} 次仍未通过验证，失败步骤: {actions 列表}"
   discussion_topic 或 f"Bug {platform_bug_id}（{title}）自动修复失败，
                        请评审不适用场景并决定人工接手方案"

F4 InapplicableCase 落库（models.py:244-255）
   session.add + flush 拿 id；status 默认 "open"

F5 StageResult(need_intervention, InterventionRequest(
       type="discussion", assignee_role="developer",
       wait_state=WAIT_DISCUSS,
       title=f"Bug {platform_bug_id} 修复失败待讨论",
       context={inapplicable_case_id, reason, failed_steps}))

F6 先建单后迁移（orchestrator.py:149-152，顺序不可倒）
   ① ctx.interventions.create（intervention.py:40-61）：
      status="pending"、审计 intervention_create、
      **创建即通知 developer**（content=str(context)[:500]，
      link=/interventions/{id}）
   ② 再 _transition(LEARNING → WAIT_DISCUSS)
   （WAIT_DISCUSS 在默认 status_map 无映射 → 不回写平台）

OUT-F：任务阻塞 WAIT_DISCUSS，等待人工 POST 回写（§3.3 三回写）
```

Stage 级未捕获异常 → Orchestrator 兜底（orchestrator.py:185-204）：审计 `stage_exception` → `FAILED`（可断点续跑）。实际上 learning 双分支的 LLM 异常已在 F2 吞掉，该兜底在此阶段极少触发。

## 3. 机制小节

### 3.1 经验 upsert 去重算法（experience.py:36-54）

- **唯一键**：`category` 等值 AND `problem_signature`（=bug.title）等值 AND `status=="active"`——**纯查询去重，experience 表无 DB 唯一约束**（models.py:168-186），并发下可重复插入；
- **命中** → 五个文本字段（symptoms / root_cause_pattern / fix_pattern / verification_points / applicable_conditions）**非空才覆盖**，空值不抹旧值；`source_task_ids` 去重追加；`version += 1`；flush 返回旧条目；
- **未命中** → `save()` 新增，`version=1`；
- **hit_count 与 upsert 无关**：只在修复阶段复用命中时 `hit()` +1（experience.py:79-84）——旧版文档称 learning 写 hit_count 是**错误的**，此处修正。

### 3.2 失败分析 LLM 调用链（learning.py:93-108 → llm_gateway.py:261-277）

1. `analyze` 入口先 `_check_budget`：单任务累计 token ≥ `task_token_budget` 或当日 ≥ `daily_token_budget` → `BudgetExceededError`；
2. `with_structured_output(FailureAnalysis)`，`for _ in range(stage_max_retry + 1)` 循环：JSON/Schema 校验失败记 warning 重试；成功即 `_record_usage`（stage="learning"）返回；全败抛 `ValueError`；
3. learning 侧 `except Exception: return FailureAnalysis()`——**预算超限、多次校验失败等一切异常都吞掉**，失败分支绝不因 LLM 故障中断；
4. Fake 模式兜底应答按模板标题 `"# 失败分析"` 路由（llm_gateway.py:158-161），返回固定的三字段假分析。

### 3.3 讨论三回写（intervention.py:125-134，resolve 的 discussion 分支）

- `action` 缺省默认 `"manual_fix"`（result 无 action 键时）；
- 映射：`manual_fix → MANUAL`、`close → CLOSED`、`retry → FIXING` 且 **`task.retry_count = 0`**（人工决定重试，FR-MEM-02）；未知 action 抛 `ValueError`；
- 每条回写前先把介入单置 `resolved` + 审计 `intervention_resolve`，再经 `_transition_task`（intervention.py:63-76）：`assert_transition` 状态机校验 + TaskStateHistory（stage="intervention"）+ state_transition 审计 + **writeback 钩子**（Orchestrator 注入，§3.4）；
- 注意：`_transition_task` 与 Orchestrator `_transition` 是**两套独立实现**——后者在 CLOSED 时写 `task.closed_at`，前者不写（§6 已知问题）。

### 3.4 平台回写完整链（writeback.py:16-40）

- **触发点两处**：① Orchestrator `_transition` 每次状态迁移后（orchestrator.py:137-140）；② InterventionService `_transition_task` 的注入钩子（orchestrator.py:94-98 构造闭包传入）；
- `settings.status_map` 查映射，**默认仅三键**（config.py:92-94）：`CLOSED→已关闭`、`WAIT_INFO→待补充`、`MANUAL→处理中-转人工`；无映射状态（WAIT_DISCUSS / FIXING / VERIFYING…）**直接 return 不回写**；
- 命中映射 → `BugPatch(status=mapped, comment=f"autobugfixer 任务状态: {to_state}")` → `platform.update_bug`，`range(2)` 首次 + 重试一次；
- 成功 → 审计 `platform_writeback`（detail 含 to_state/mapped）；两次均败 → 审计 `platform_writeback_failed` + notify ops（通知发送自身异常再吞掉）；
- 全函数**绝不向调用方抛异常**——回写失败不影响任务状态迁移（R5）。

### 3.5 CLOSED 的两条路（已对齐）

| 路径 | 迁移实现 | 写 closed_at | 平台回写 |
|---|---|---|---|
| learning 成功分支 | `Orchestrator._transition`（orchestrator.py:123-124） | ✅ `datetime.now(timezone.utc)` | CLOSED→已关闭 |
| 讨论 close 回写 | `InterventionService._transition_task`（intervention.py） | ✅ 已补写（Spec 08 §7 已知问题修复） | 经注入钩子同样回写已关闭 |

### 3.6 经验复用闭环（跨阶段语义，本 spec 收口）

- **检索**（experience.py:56-68，fixing.py:156-169 调用）：`find_relevant(modules=bug.affected_modules, keywords=title 分词≥2字符, limit=3)`——全表取 `status=="active"` 后**内存子串匹配**：模块名 in `problem_signature`/`applicable_conditions` 或关键词 in `problem_signature`/`symptoms`；
- **命中后**（fixing 侧）：每条 `hit()` 使 `hit_count += 1` + 审计 `experience_hit`，`fix_pattern[:200]` 以"历史修复经验"块拼入修复 prompt，FixRecord 记 `experience_hit=True`；
- 闭环：成功修复 → §2.1 upsert 沉淀（version 递增）→ 后续同类 Bug 修复时检索命中注入 → 再沉淀。`hit_count` 是该回路唯一的复用计量字段。

## 4. 异常矩阵

| 场景 | 行为 | 结果 |
|---|---|---|
| 无任何 VerifyRecord 进入 LEARNING | 分流判定 verified=False | 失败分支，failed_steps=[]，不抛错 |
| fix_record 缺失（理论不可达） | `fix.summary if fix else ""` | 成功分支继续，fix_pattern 为空 |
| LLM 预算超限 / 多次校验失败 / 网络异常 | analyze 抛错 → except 吞掉 → 空 FailureAnalysis | 规则模板兜底，失败分支继续 |
| failed_steps 为空列表 | JSON "[]" 进 prompt，模板 reason 中步骤列表为空 | 照常落库 |
| discussion 回写未知 action | ValueError 抛给调用方 | 介入单事务语义由 API 层会话决定 |
| 平台回写两次均失败 | platform_writeback_failed 审计 + ops 通知 | 任务照常 CLOSED/WAIT_DISCUSS |
| ops 通知自身失败 | `except Exception: pass` | 仅丢通知 |
| Stage 级其他未捕获异常 | Orchestrator 兜底 stage_exception | FAILED 可续跑 |

## 5. 数据与配置

**写表**：`experience`（upsert 五字段/version/source_task_ids）、`inapplicable_case`（三文本字段 + status="open"）、`intervention`、`task`（state、closed_at 仅成功路径、retry_count 仅 retry 回写）、`task_state_history`、`audit_log`（state_transition / intervention_create / intervention_resolve / platform_writeback[_failed] / experience_hit）、`llm_usage`（stage="learning"，仅失败分支有调用）。
**读表**：`verify_record`、`fix_record`、`bug_ticket`。

| 配置（`AUTOBUGFIXER_` 前缀） | 默认 | 说明 |
|---|---|---|
| `STATUS_MAP` | CLOSED→已关闭、WAIT_INFO→待补充、MANUAL→处理中-转人工 | 平台回写映射（11.7）；WAIT_DISCUSS 等无键状态不回写 |
| `STAGE_MAX_RETRY` | 2 | analyze 校验重试（实际尝试 = +1 次） |
| `TASK_TOKEN_BUDGET` / `DAILY_TOKEN_BUDGET` | 100k / 1M | 失败分析调用前预算检查 |
| `NOTIFIER_TYPE / IM_WEBHOOK_URL` | log / — | tester/developer/ops 通知通道 |

经验库导出：CLI `autobugfixer-export --format markdown`（导出前脱敏，FR-SYS-03）。

## 6. 测试映射（已逐一核对，含错引修正）

| 条款 | 测试 | 备注 |
|---|---|---|
| 成功路径经验沉淀（task_id in source_task_ids）+ 平台回写"已关闭" + 全状态历史含 LEARNING/CLOSED | `test_e2e.py::test_end_to_end_full_pipeline` | 真实存在（59-61、75-76 行） |
| 经验检索注入 prompt + hit_count==1 | `test_experience_reuse.py::test_experience_injected_into_fix_prompt` | |
| upsert 去重：entries==1、version==2、source_task_ids==2 | `test_experience_reuse.py::test_experience_upsert_dedup` | |
| 失败分支：InapplicableCase（fake 兜底文案）+ discussion 介入单 pending + 终态 WAIT_DISCUSS | `test_failure_branch.py::test_failure_branch_llm_analysis`（+ fixture） | |
| 讨论三回写：retry→FIXING 且 retry_count==0 / close→CLOSED / manual_fix→MANUAL | `test_failure_branch.py` 三个 `test_discussion_*` 用例 | **旧版引 test_intervention.py 为错位**——该文件只测 info_supplement，修正 |
| CLOSED→已关闭 回写触发 | `test_notifier_writeback.py::test_writeback_on_key_states` | |
| 回写失败重试（calls≥2）+ platform_writeback_failed 审计 + 不阻塞 CLOSED | `test_notifier_writeback.py::test_writeback_failure_not_blocking` | |
| IM 通知器 payload（wecom/dingtalk/失败吞掉/配置构建） | `test_notifier_writeback.py` 前四用例 | NoticeMessage title/content/link 结构 |
| info_supplement 续跑闭环 + info_rounds 超限转 MANUAL | `test_intervention.py` 两用例 | 与本 spec 关联仅为回写机制同源（§3.3） |
| 讨论 close 同步写 closed_at（§3.5 已对齐） | `test_failure_branch.py::test_discussion_close`（断言 closed_at） | |
| 无验证记录进入 LEARNING（相同 diff 终止路径） | `test_failure_branch.py::test_learning_without_verify_record_goes_failure_branch` | 失败分支不抛错、规则模板兜底 |

## 7. 已知限制

- ~~**两套 CLOSED 迁移不一致**~~（已修复：`_transition_task` 在 CLOSED 时同步写 `task.closed_at`）；
- ~~**upsert 无 DB 唯一约束**~~（已修复：`experience` 表增加活跃条目部分唯一索引 `ux_experience_active_dedup`）；
- ~~`root_cause_pattern` 恒空串~~（已实现：成功分支 LLM 归因总结填充，`experience_digest_v3` 模板含归类/模式化正反例，异常回退留空）；
- ~~分类为关键词五级规则~~（已实现 LLM 分类优先、关键词规则回退）；
- 环境选择：无 environment_id 时取库中第一条 Environment（Spec 06 §10 同条），applicable_conditions 记录的 env_version 来自 Bug 字段而非实际部署环境；
- 不适用场景仅入库展示（status=open 无人更新），未反向阻断后续同类任务准入（P2：评分阶段消费 InapplicableCase 抬高难度分）。
