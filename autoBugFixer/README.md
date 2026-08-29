# autobugfixer 自动化 Bug 修复系统

从缺陷平台/CSV 拉取 Bug，经"预处理（完整性分析 → 验证方案 → 难度评分）→ AI 修复 → 自动部署验证 → 经验沉淀"状态机流水线，实现简单 Bug 的全自动闭环修复；关键节点保留人工介入（信息补充 / 方案确认 / 失败讨论 / 优化评审）。

架构一句话：**状态机驱动的单体流水线**——任务状态持久化于关系库（默认 SQLite），Orchestrator 按状态路由到可插拔 Stage，外部系统（缺陷平台、测试环境、通知、LLM）全部走适配器，Fake LLM 模式无需 API Key 即可跑通全链路。

## 安装

```bash
python -m venv .venv
.venv/Scripts/pip install -e ".[dev]"   # Windows；Unix 用 .venv/bin/pip
```

要求 Python 3.11+。

## 快速开始

```bash
# 1. CSV 批量导入 + 预处理分析（Fake LLM，无需 Key）
.venv/Scripts/autobugfixer-import examples/bugs_sample.csv --run-analysis

# 2. 启动 API + Web 控制台（http://127.0.0.1:8000/ 看板，/docs 接口文档）
.venv/Scripts/autobugfixer-api

# 3. 常驻调度器（轮询拉新 / 优先级出队 / 超时回收 / 介入 SLA）
.venv/Scripts/autobugfixer-scheduler          # --once 只跑一轮

# 4. 导出经验知识库（Markdown，导出前脱敏）
.venv/Scripts/autobugfixer-export --format markdown --out var/kb.md
```

## 测试

```bash
.venv/Scripts/python -m pytest        # 全量（含端到端：Fake LLM + Mock 平台 + 本地仿真环境）
```

## 配置（环境变量，前缀 `AUTOBUGFIXER_`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./autobugfixer.db` | 数据库连接 |
| `LLM_MODE` | `fake` | `fake` / `anthropic`（后者需 `ANTHROPIC_API_KEY`） |
| `LLM_MAX_TOKENS` | `4096` | 分析类 LLM 调用输出上限（planning 固定放宽到 8192 防 JSON 截断） |
| `CODEX_EXECUTABLE` / `CODEX_MODEL` | `codex` / — | codex exec 修复通道（需 `OPENAI_API_KEY` 或 `codex login`） |
| `CODEX_TIMEOUT` / `CODEX_SANDBOX` | `600` / `workspace-write` | codex 调用超时与沙箱（只能写工作区，禁网） |
| `BUG_PLATFORM` | `mock` | `mock` / `jira` / `zentao`（CSV 走导入通道） |
| `ADMISSION_THRESHOLD` | `60` | 综合评分准入阈值（低于入队，否则转人工） |
| `SCORING_ENGINE` | `v1` | `v1`（LLM 直接打分）/ `v2`（rubric 判定表单 + 本地映射四维分，Spec 04 §8） |
| `SCORE_V2_WEIGHT_LOCATE/FIX/VERIFY/BLAST` | `0.3/0.3/0.2/0.2` | v2 四维权重（定位/修改/验证/波及） |
| `SCORE_WEIGHT_FIX/VERIFY/CHANGE` | `0.4/0.3/0.3` | 三维评分权重 |
| `MAX_RETRY` | `3` | 修复-验证重试上限 |
| `PERCEPTION_ENABLED` | `false` | 三维感知（页面/DB/接口快照对比）开关 |
| `USE_GIT_WORKTREE` | `false` | 修复工作区走 `git worktree` + `autofix/<bug-id>` 分支 |
| `NOTIFIER_TYPE` / `IM_WEBHOOK_URL` | `log` | `log` / `im`（企业微信/钉钉机器人） |
| `STATUS_MAP` | 见 config | 系统状态 → 平台状态回写映射（JSON） |
| `SCHEDULER_POLL_INTERVAL_SECONDS` | `60` | 调度器轮询间隔 |
| `SCHEDULER_DISPATCH_LIMIT` | `2` | 单轮出队任务数上限 |
| `INTERVENTION_SLA_HOURS` / `INTERVENTION_ESCALATION` | `24` / `remind` | 介入 SLA 与超时动作（remind/suspend；deadline 随介入单创建自动填充） |
| `TASK_CLAIM_LEASE_SECONDS` | `900` | 任务认领租约：调度器/API/webhook 并发驱动同一任务时的双驱防护 |
| `FERNET_KEY` | 开发兜底 | 凭据加密主密钥（生产必配） |

## 目录结构

```
src/autobugfixer/                # 树状分包：common 通用 / features 功能 / adapters 适配
├── common/                      # 通用基础层（零业务依赖）
│   ├── core/                    #   内核：config/models(14+ 表)/state 状态机/stage 协议/
│   │                            #   llm 网关(fake/anthropic+计量预算)/audit/bugtext
│   ├── dsl/                     #   验证 DSL：动作词表 + Schema + 解释执行器
│   ├── prompts/                 #   版本化提示词模板 + 评分 rubric
│   └── security/                #   Fernet 凭据、注入防护、脱敏
├── features/                    # 业务功能层，每个功能一个子包
│   ├── ingest/                  #   阶段01：平台/CSV/Webhook 接入、幂等入库、仓库门禁
│   ├── completeness/            #   阶段02：完整性分析（FR-PRE-02）
│   ├── planning/                #   阶段03：验证方案生成（FR-PRE-03）
│   ├── scoring/                 #   阶段04：难度评分（v1 + v2 rubric，FR-PRE-04）
│   ├── fixing/                  #   阶段05：AI 修复（codex 通道 + 工作区 + 出口校验）
│   ├── deploying/               #   阶段06：部署（环境锁 + 回滚）
│   ├── verifying/               #   阶段07：回归验证（DSL 执行 + 证据落盘）
│   ├── learning/                #   阶段08：经验沉淀与关闭
│   ├── knowledge/               #   经验库、技能库、知识库导出
│   ├── perception/              #   三维感知（FR-FIX-02）
│   ├── intervention/            #   人工介入（HITL）+ 通知（log/im）
│   └── optimization/            #   自我优化：策略建议与版本化（FR-SYS-02）
├── adapters/                    # 外部系统适配层
│   ├── platform/                #   缺陷平台适配（mock/jira/zentao）+ 状态回写
│   └── env/                     #   环境执行器（local/ssh/docker）+ 白名单 + 环境锁
├── runtime/                     # 编排：Orchestrator、Scheduler、适配器注册表
├── api/                         # FastAPI 对内接口 + web/ 静态控制台
└── cli/                         # 命令行入口：import_cli / scheduler_cli / export_cli
tests/                           # 247 条用例（单元 + 端到端 + API）
examples/bugs_sample.csv         # 中文示例 CSV（utf-8-sig）
docs/                            # PRD、整体方案设计、阶段 specs、测试用例设计
```

## 说明

- 默认 `llm_mode=fake`：结构化分析（完整性/方案/评分/失败分析）与修复 agent 均为脚本化应答，供 CI 与本地开发。
- 真实分析模式：`AUTOBUGFIXER_LLM_MODE=anthropic` + `AUTOBUGFIXER_ANTHROPIC_API_KEY`，或
  `AUTOBUGFIXER_LLM_MODE=deepseek` + `AUTOBUGFIXER_DEEPSEEK_API_KEY`（OpenAI 兼容接口，
  模型/地址可用 `AUTOBUGFIXER_DEEPSEEK_MODEL` / `AUTOBUGFIXER_DEEPSEEK_BASE_URL` 覆盖）。
- 修复驱动：`AUTOBUGFIXER_FIX_DRIVER=codex`（默认，codex exec 子进程，需 codex CLI + OpenAI 鉴权），
  或 `AUTOBUGFIXER_FIX_DRIVER=deepseek`（DeepSeek 智能体回路，与 codex 同接口；修复模型
  `AUTOBUGFIXER_DEEPSEEK_FIX_MODEL`，未配置回落分析模型）。
- 设计依据：`docs/` 下 PRD 与整体方案设计（状态机见 3.1、数据模型 5.1、接口 6.1、补充设计 11.1~11.6）。
- 设计依据：`docs/` 下 PRD 与整体方案设计（状态机见 3.1、数据模型 5.1、接口 6.1、补充设计 11.1~11.6）。
