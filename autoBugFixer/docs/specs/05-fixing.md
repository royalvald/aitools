# Spec 05 · AI 修复（Fixing）

| 项 | 值 |
|---|---|
| 涉及状态 | `FIXING`（执行态）；上游 `SCORED/WAIT_DISCUSS/FAILED/VERIFYING(重试环)` 均汇入 |
| 源码 | `src/autobugfixer/pipeline/stages/fixing.py`、`stages/common.py` |
| 提示词 | `prompts/templates/fixing_v1.md`、`fixing_retry_v1.md` |
| 需求 | FR-FIX-01（修复留痕）、FR-FIX-02（三维感知，默认关）、FR-MEM-01（经验复用）、11.2（安全防护）、11.5（重试反馈回路） |
| 上游 | 评分准入（Spec 04） |
| 下游 | 部署（Spec 06）/ 经验沉淀失败分支（Spec 08） |
| 修复通道 | `langchain`（默认，LLMGateway 内建 agent）或 `claude_code_cli`（headless CLI） |

## 1. 目标与职责

在**隔离工作区**内由 AI agent 产出修复变更，并施加出口侧安全校验：

1. 准备隔离工作区（git worktree 或目录快照）；
2. 组装修理指令：Bug 上下文 + 验证方案验收点 + 经验复用块 +（重试时）失败反馈 +（可选）感知基线；
3. 修复通道执行，产出变更文件与 diff；
4. 出口校验：禁改路径、空变更、重复 diff 提前终止；
5. 全量留痕（FixRecord 含 prompt 快照）。

## 2. 输入与前置条件

- 任务状态 `FIXING`；`attempt = task.retry_count + 1`（1 起始）；
- 分支命名：`autofix/{platform_bug_id}`；
- 最新 `verification_plan`（验收点来源，无则"(无验证方案)"占位）；
- 历史 `fix_record`（全部尝试）与失败 `verify_record`（重试反馈来源）。

## 3. 处理流程

```
1. prepare_workspace（见 §3.1）
2. 感知基线（PERCEPTION_ENABLED 且注入 perception 服务时）：
   capture(task, plan, "pre_fix")；异常摘要注入 prompt（前 10 条）；
   失败不阻断主链路
3. 组装 prompt（attempt=1 → fixing_v1；attempt≥2 → fixing_retry_v1）：
   bug_block（注入防护）
   + 验收点（方案步骤 desc/action + expected_results）
   + 经验块（见 §3.2）
   + 感知基线摘要（可选）
   + [重试] previous_attempts（历史 FixRecord 摘要，各截 300 字）
          + failure_evidence（历史失败 VerifyRecord 的失败步骤 JSON）
4. 修复通道执行：
   channel = ctx.fix_channel（claude_code_cli）或 ctx.llm（langchain）
   agent = channel.create_fix_agent(工作区工具集)   # 见 §3.3
   summary = channel.run_fix_agent(agent, prompt)    # 计量 + 预算检查
5. compute_diff(workspace) → (changed_files, unified diff)
   current_hash = diff_hash(diff)（sha256 前 16 位）
6. 落库 FixRecord（prompt 快照、changed_files、diff、diff_hash、summary、experience_hit）
   + 审计 fix_attempt
7. 出口校验与分流（见 §4）
```

### 3.1 工作区准备（`prepare_workspace`）

- 路径：`{WORKSPACE_ROOT}/task-{task.id}`，每次重建（先删后建，保证幂等）；
- `USE_GIT_WORKTREE=true` 且 `repo_url` 为本地 git 仓库：清理残留后 `git worktree add -b autofix/{bug-id} <branch>`（受控分支）；失败回退快照方案；
- 快照方案：复制源目录（跳过 `.git`）并建 `.baseline/` 基线副本供 diff 比对；
- git 工作区用 `git diff --cached`（暂存后取全量含新增文件），快照方案用 `difflib.unified_diff` 对比 `.baseline`。

### 3.2 经验复用回路（FR-MEM-01）

- 检索：`ExperienceService.find_relevant(modules=affected_modules, keywords=title 分词, limit=3)`，匹配 `problem_signature/symptoms/applicable_conditions`；
- 命中：每条 `hit_count += 1`（审计 `experience_hit`），摘要素材注入 prompt（fix_pattern 前 200 字），`FixRecord.experience_hit=True`；
- 提示语义：经验是"可参考，须结合本次 Bug 判断适用性"。

### 3.3 Agent 工具集（执行侧权限收敛，11.2）

`read_file / write_file / list_dir / git_diff` 四个工具，**全部路径解析限制在工作区内**（越出即抛错），LLM 无法触碰工作区外文件与 shell。

## 4. 输出与状态迁移（出口校验）

| 校验 | 结果 | 迁移 | 说明 |
|---|---|---|---|
| 禁改路径命中（`FORBIDDEN_PATHS` glob） | `failed` | `→ MANUAL` | 安全红线，直接转人工（不再重试） |
| `changed_files` 为空 | `failed` | `→ FAILED` | 可断点续跑重试 |
| `current_hash` 与历史任一 FixRecord 相同 | `failed` | `→ LEARNING` | 相同 diff 提前终止重试（11.5），走失败分支 |
| 以上均不命中 | `success` | `→ DEPLOYING` | 携带 `fix_record_id / changed_files` |

## 5. 数据模型

- 写：`fix_record`（attempt、branch、worktree、prompt_version、prompt_snapshot、changed_files、diff、diff_hash、summary、experience_hit）、`task_state_history`、`audit_log`、`llm_usage`、`experience.hit_count`；
- 读：`verification_plan`、`fix_record`（历史）、`verify_record`（失败证据）、`experience`。

## 6. 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `FIX_CHANNEL` | `langchain` | `langchain` / `claude_code_cli` |
| `CLAUDE_EXECUTABLE` / `CLAUDE_TIMEOUT` | `claude` / `600s` | CLI 通道参数 |
| `USE_GIT_WORKTREE` | `false` | 工作区模式 |
| `WORKSPACE_ROOT` | `./var/workspaces` | 工作区根目录 |
| `FORBIDDEN_PATHS` | `.env,*.key,*.pem,deploy/*,secrets/*` | 出口侧禁改清单（glob） |
| `PERCEPTION_ENABLED` | `false` | 感知基线开关 |

## 7. 异常与失败处理

- 修复通道崩溃/超时/预算超限 → Stage 异常 → Orchestrator 兜底 `FAILED`；
- git worktree 不可用 → 自动回退目录快照（降级不失败）；
- 感知采集失败 → 仅告警，修复继续；
- 重试语义：验证失败回退时 `retry_count += 1`，故同一任务最多执行 `max_retry + 1` 次修复（见 Spec 07 §4）。

## 8. 人工介入点

无直接介入。禁改路径违规与超阈值一样落 `MANUAL`；修复反复失败的讨论介入在 Spec 08。

## 9. 安全约束（11.2 三层）

1. **输入侧**：Bug 文本注入防护（检测留痕 + 包裹）；
2. **执行侧**：agent 工具路径沙箱（仅工作区）；
3. **出口侧**：禁改路径 glob 校验（命中即转人工）+ prompt 快照落库可回放。

## 10. 验收标准

- 产出变更的任务落 `FixRecord` 且进入 `DEPLOYING`（`tests/test_e2e.py`）；
- 修改 `.env` 等禁改路径 → `MANUAL`（`tests/test_failure_branch.py`）；
- 无变更 → `FAILED`；与历史相同 diff → 直接 `LEARNING` 失败分支；
- 工作区路径越界被工具层拒绝（`test_whitelist.py` 相应边界）；
- 经验库命中条目注入 prompt 且 `hit_count` 递增（`test_experience_reuse.py`）；
- git worktree 模式创建 `autofix/<bug-id>` 分支并清理残留（`test_git_worktree.py`）。

## 11. 已知限制与演进

- 重试反馈为结构化摘要（各 300 字截断），非全量日志；
- `claude_code_cli` 通道依赖本机 CLI 可执行文件；生产建议容器化隔离；
- 感知默认关闭（P1）；修复指令无多 agent 协作（P2）。
