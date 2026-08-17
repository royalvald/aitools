# Spec 05 · AI 修复（Fixing）——Codex 驱动

| 项 | 值 |
|---|---|
| 涉及状态 | `FIXING`（执行态）；出口 `{DEPLOYING, MANUAL, FAILED, LEARNING}` |
| 修复驱动 | **`codex exec`（唯一通道，本 spec 已实现）**——headless 子进程，OpenAI Codex CLI |
| 源码 | `pipeline/stages/fixing.py`、`pipeline/stages/common.py`、`adapters/codex_cli.py`（新增）；遗留移除清单见 §6 |
| 提示词 | `prompts/templates/fixing_v1.md`、`fixing_retry_v1.md`（内容不变，codex 对格式无感） |
| 上游 / 下游 | 评分准入（Spec 04）、验证重试环（Spec 07）→ 部署（Spec 06）、失败经验（Spec 08） |

> 决策记录（2025 走查确认）：修复驱动统一为 Codex；langchain 修复通道、claude_code_cli 通道、fake 修复模拟**全部移除**（范围仅限修复路径；分析类阶段的 LLM 调用与 Fake 结构化输出不受影响，否则无 Key 测试体系崩塌，见 §6 边界）。

## 1. 目标

在隔离工作区内由 **Codex CLI 自主完成代码修复**：系统准备环境、组装指令、以受控参数调起 `codex exec` 子进程、对产物做出口验收。理解-定位-修改的驱动过程在 Codex 内部闭环，本系统不干预。

| # | 预期 | 验证方式 |
|---|---|---|
| R1 | 每次尝试恰好 1 条 `FixRecord`（prompt 全文快照 + diff + 哈希），成功失败违规一律留痕 | `fix_record` + 审计 `fix_attempt` |
| R2 | 修复只发生在隔离工作区（codex 沙箱 workspace-write 强制 + 出口侧复核） | 沙箱参数 + diff 范围 |
| R3 | 禁改路径命中 → `MANUAL` 不重试；零变更 → `FAILED` 可续跑；重复 diff → `LEARNING` 提前终止 | 状态历史 message |
| R4 | attempt≥2 的尝试自动携带历史修复摘要与验证失败证据（11.5） | retry 模板 prompt 快照 |
| R5 | 经验库命中注入指令且 `hit_count` 递增 | `experience_hit=True` + prompt 含经验块 |
| R6 | 每次 codex 调用的 token 用量写入 `llm_usage`（从事件流解析，不留计量缺口） | `llm_usage(stage="fixing")` |

## 2. 修复驱动全过程

### 2.1 一次尝试的完整时序

```
进入 FIXING
  ① attempt = retry_count + 1 → 选模板（1→fixing_v1，≥2→fixing_retry_v1）
  ② prepare_workspace → 三形态之一（§3）
  ③ （可选，默认关）pre_fix 感知快照，异常前 10 条做注记；失败不阻断
  ④ 组装 prompt（§4）：bug 块 + 验收点 +（经验块/感知注记/历史反馈）
  ⑤ 调用 codex exec 子进程（§2.2）——修复主体在 Codex 内部闭环，最终消息 = summary
  ⑥ compute_diff（工作区 vs 基线）→ changed_files + unified diff → sha256[:16] 哈希
  ⑦ FixRecord 落库 + 审计 fix_attempt + llm_usage（事件流用量）
  ⑧ 出口校验四分支（§5）→ DEPLOYING / MANUAL / FAILED / LEARNING
```

⑤ 是子进程调用，⑥⑧ 是系统的独立验收——**不信任 CLI 自述，以工作区 diff 为唯一事实**。

### 2.2 codex exec 调用规格（子系统契约）

| 项 | 规格 |
|---|---|
| argv | `[codex, "exec", <prompt>, "--cd", <workspace>, "-s", "workspace-write", "--json", "--output-last-message", <tmp文件>, "--skip-git-repo-check"]` +（配置了模型时 `--model <codex_model>`）；**参数列表形式，不经 shell** |
| 鉴权 | `OPENAI_API_KEY` 环境变量或本机 `codex login`；启动预检（Spec 02 B0 扩展）静态检查 CLI 可执行 + 鉴权配置 |
| 沙箱 | `workspace-write`：进程**只能写工作区内文件**，网络默认禁用（修复不需要外网；如需装依赖属 P2 放开评估）。原 make_workspace_tools 字符串前缀沙箱整体废弃，其已知前缀逃逸弱点随之消灭 |
| `--skip-git-repo-check` | 目录快照/空工作区不是 git 仓库，必须跳过 codex 的 git 仓库前置检查；git worktree 形态天然满足 |
| 输出 | `--json` JSONL 事件流（逐行 JSON：执行过程/文件变更/用量事件）→ 解析用量事件写 `llm_usage`；`--output-last-message` 指定文件读取最终文本 = summary（修复说明） |
| 产物 | changed_files/diff **一律由 ⑥ compute_diff 独立计算**，不解析 CLI 事件流中的文件清单作准 |
| 超时 | `codex_timeout` 默认 600s，超时杀进程 → 本次尝试失败 |
| 退出码 | 非 0 → `CodexError`（含 stderr 前 500 字）→ 本次尝试失败 |
| 配置 | `codex_executable`（默认 `codex`）、`codex_model`、`codex_timeout`、`codex_sandbox`（默认 workspace-write） |

### 2.3 驱动过程语义（Codex 内部）

codex exec 收到 prompt 后在其内部自主完成"探索（read/grep）→ 定位 → 修改（edit/apply_patch）→ 自查"循环，工具链与轮数上限由 Codex CLI 自身管理——本工程不再有 agent 循环、递归上限、工具集的概念（原 langchain 版的 §2.2-2.3 机制随通道一并移除）。系统侧唯一控制点：prompt 内容（④）+ 沙箱参数 + 超时 + 出口验收。

### 2.4 完整实例：BUG-T001 目标态 trace

前置：工作区 = repo 快照（`api/health.json` = `{"status": "fail"}`）+ `.baseline` 副本；注入测试桩 `ScriptedCodexCLI`（§2.5）模拟子进程直接改写工作区文件。

| 步骤 | 动作 | 结果 |
|---|---|---|
| ④ | 组装 prompt | fixing_v1 填充：bug 七行块 + 验收点（方案两步 desc + "预期: status 为 ok"） |
| ⑤ | codex exec（桩） | 桩在 workspace 内把 `api/health.json` 覆写为 `{"status": "ok"}`，最终消息文件写"修复完成：已将 status 修正为 ok."，事件流含模拟用量事件 |
| ⑥ | compute_diff | difflib 对比 `.baseline` → `changed_files=["api/health.json"]`，diff 含 `-fail`/`+ok` |
| ⑦ | FixRecord | attempt=1、branch、prompt 快照、diff、哈希、summary；llm_usage 记录桩用量 |
| ⑧ | 出口校验 | 非禁改、非空、非重复 → `DEPLOYING` |

### 2.5 测试注入策略（非 Fake LLM 模式）

`codex exec` 依赖外部 CLI 与 API Key，全链路测试不可真实调用。测试注入**桩**：`ScriptedCodexCLI` 与 `CodexCLI` 同接口（构造 argv → 执行 → 返回事件流/最终消息/退出码），e2e 套件 monkeypatch 替换子进程执行点。这是标准测试替身，不是被移除的 Fake 修复模拟——生产路径无桩、必真调 codex。

## 3. 工作区三形态（prepare_workspace，不变）

路径 `{workspace_root}/task-{task.id}`，每次先删后建（幂等）。

| 形态 | 条件 | diff 来源 |
|---|---|---|
| git worktree | 开关开 + repo_url 为本地 git 仓库；清残留后 `worktree add -b autofix/{bug-id}` | `git add -A` + `diff --cached HEAD` |
| 目录快照 | repo_url 为本地非 git 目录，或 worktree 失败回退 | 复制源目录 + `.baseline/` 副本，difflib 对比 |
| 空工作区 | repo_url 空/非本地目录 | 空目录开修，产出全为新增文件（Spec 01 §9 P1 后废除） |

git diff 失败返回空变更 → 表现为 §5 零变更失败，不抛异常。

## 4. 修复指令组装（不变）

**fixing_v1**（attempt=1）= bug 块（七行结构化 + untrusted 包裹）+ acceptance（最新版方案每步 desc-or-action 一行 + 每条预期一行；无方案占位"(无验证方案)"）；经验块（`find_relevant` 命中注入 `fix_pattern[:200]` + `hit_count+1`）与感知注记拼接在 acceptance 尾部。

**fixing_retry_v1**（attempt≥2）额外：`previous_attempts`（历史 FixRecord：attempt/changed_files/summary[:300]/diff[:300] JSON）+ `failure_evidence`（失败 VerifyRecord 的失败步骤 JSON）。

**Codex 看不到**：仓库全貌（仅工作区副本）、评分结论、DSL 步骤参数原文、代码实证结果（P1 接入）。

## 5. 出口校验（FixRecord 先无条件落库，再依序判定；不变）

| 序 | 校验 | 结果 | 迁移 |
|---|---|---|---|
| 1 | 变更文件 fnmatch 禁改清单（默认 `.env,*.key,*.pem,deploy/*,secrets/*`，全路径或文件名双匹配） | failed | `MANUAL`（安全红线不重试） |
| 2 | `changed_files` 为空 | failed | `FAILED`（断点续跑） |
| 3 | diff 哈希与本任务历史任一尝试相同（11.5） | failed | `LEARNING`（提前终止，走失败经验分支） |
| 4 | 均不命中 | success | `DEPLOYING`（携带 fix_record_id + changed_files） |

## 6. 通道整合与移除清单（迁移记录）

**新增**：`adapters/codex_cli.py`（`CodexError` + `CodexCLI` 子进程封装 + 事件流解析 + 用量提取）；`pipeline/stages/fixing.py` ⑤ 处改为调用 CodexCLI；配置四项（§2.2）；启动预检补 codex 检查。

**移除**：

| 移除项 | 说明 |
|---|---|
| `LLMGateway.create_fix_agent / run_fix_agent` | langchain 修复通道；`analyze`（分析类结构化输出）**保留** |
| `adapters/claude_code_cli.py` 整个适配器 | 连同 `test_adapters_real.py` Claude 段测试 |
| `MeteredFixChannel` | 为 CLI 通道补计量的包装，随 claude 通道移除；codex 通道内建事件流计量 |
| `make_workspace_tools` + 4 工具 | 沙箱职责移交 codex workspace-write；其字符串前缀逃逸弱点（task-1→task-11）随之消灭，不再需要修复 |
| `ScriptedFakeChatModel` 的修复兜底应答 | `{"tool_calls": [write_file...]}` 与 ToolMessage 短路逻辑（`_generate` 前两段修复相关分支） |
| 配置 `FIX_CHANNEL / CLAUDE_EXECUTABLE / CLAUDE_TIMEOUT` | 由 codex 四配置替代 |

**边界（重要）**：移除范围仅修复路径。完整性/方案/评分/失败分析四类 `ctx.llm.analyze` 调用与 Fake 模式结构化输出**全部保留**——无 Key 测试体系（161 项）依赖它，Spec 02/03/04 的 as-built 描述不受影响。

**测试改造**：依赖修复动作的 e2e 系测试（test_e2e / test_git_worktree / test_experience_reuse / test_env_lock / test_failure_branch / test_scoring 部分 / test_api_fields_perception）统一注入 `ScriptedCodexCLI` 桩；真实 codex 冒烟为手动步骤，不进 CI。

## 7. 异常矩阵

| 场景 | 行为 | 结果 |
|---|---|---|
| codex CLI 未安装 / 鉴权未配置 | 启动预检拦截（B0 扩展）；运行期 FileNotFoundError → CodexError | 预检失败拒绝启动 / 尝试 `FAILED` |
| 超时（默认 600s） | 杀进程 | 本次尝试 `FAILED` |
| 退出码非 0 | CodexError（stderr[:500]） | 本次尝试 `FAILED` |
| 沙箱拒绝写（越出工作区） | codex 内部报错 → 非零退出或零变更 | `FAILED`（原前缀逃逸面已不存在） |
| 零变更 | 出口校验 2 | `FAILED` 可续跑 |
| 禁改路径命中 | 出口校验 1 | `MANUAL`，FixRecord 留痕 |
| 重复 diff | 出口校验 3 | `LEARNING` 失败分支 |
| 事件流用量解析失败 | 告警，用量记 0，不阻断 | 尝试照常，计量缺该次 |
| 预算超限 | 调用前拦截 `BudgetExceededError` | `FAILED` |
| 感知采集失败 | warning + 空注记 | 修复继续 |

## 8. 验收条款

| # | 条款 | 测试 |
|---|---|---|
| A1 | 桩注入全链路：FixRecord 留痕（branch/changed_files/diff/prompt_snapshot）且 CLOSED | `test_end_to_end_full_pipeline`（改造后） |
| A2/A3 | git worktree 模式分支真实存在 / 非 git 回退快照 | `test_git_worktree.py` 两用例（桩改造后） |
| A4 | 经验命中注入 + hit_count+1 | `test_experience_injected_into_fix_prompt`（桩改造后） |
| A5 | codex argv 构造：沙箱/工作目录/skip-git-repo-check/参数列表不经 shell | **新增单测**（纯本地） |
| A6 | 事件流解析：用量事件 → llm_usage；最终消息文件 → summary | **新增单测**（样例 JSONL 固定输入） |
| A7 | 五类异常（缺失/超时/非零退出/鉴权/输出不可解析）| **新增单测**（monkeypatch 子进程，模式同原 Claude 段） |
| A8-A10 | 禁改→MANUAL / 零变更→FAILED / 重复 diff→LEARNING | **无覆盖，待补**（原有缺口不变） |
| 真实冒烟 | 真 codex 修 BUG-T001 | 手动，不进 CI |

## 9. 已知限制与 P1 联动

- 依赖本机 codex CLI + OpenAI 鉴权；无 Key 环境仅桩测试可跑（真实链路冒烟需专用环境）；
- 沙箱禁网：修复中无法装依赖/拉包（需联网场景 P2 评估定向放开）；
- 事件流 schema 随 codex 版本演化，解析器需带版本容错（实现时对齐当前版本文档）；
- Spec 01 §9（空工作区废除）、Spec 03 §9.4（fix_approach 注入首轮 prompt）、Spec 04 §8.6（代码实证注入）联动不变——三者都以"修复驱动收 prompt"为注入点，codex 化不影响。
