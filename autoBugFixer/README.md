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
| `FIX_CHANNEL` | `langchain` | `langchain` / `claude_code_cli`（headless CLI 修复） |
| `BUG_PLATFORM` | `mock` | `mock` / `jira` / `zentao`（CSV 走导入通道） |
| `ADMISSION_THRESHOLD` | `60` | 综合评分准入阈值（低于入队，否则转人工） |
| `SCORE_WEIGHT_FIX/VERIFY/CHANGE` | `0.4/0.3/0.3` | 三维评分权重 |
| `MAX_RETRY` | `3` | 修复-验证重试上限 |
| `PERCEPTION_ENABLED` | `false` | 三维感知（页面/DB/接口快照对比）开关 |
| `USE_GIT_WORKTREE` | `false` | 修复工作区走 `git worktree` + `autofix/<bug-id>` 分支 |
| `NOTIFIER_TYPE` / `IM_WEBHOOK_URL` | `log` | `log` / `im`（企业微信/钉钉机器人） |
| `STATUS_MAP` | 见 config | 系统状态 → 平台状态回写映射（JSON） |
| `SCHEDULER_POLL_INTERVAL_SECONDS` | `60` | 调度器轮询间隔 |
| `SCHEDULER_DISPATCH_LIMIT` | `2` | 单轮出队任务数上限 |
| `INTERVENTION_SLA_HOURS` / `INTERVENTION_ESCALATION` | `24` / `remind` | 介入 SLA 与超时动作（remind/suspend） |
| `FERNET_KEY` | 开发兜底 | 凭据加密主密钥（生产必配） |

## 目录结构

```
src/autobugfixer/
├── config.py / db.py / models.py     # 配置、引擎、14+ 张表（含 strategy_version）
├── pipeline/                         # 状态机、Orchestrator、DSL 解释器、7 个 Stage
├── adapters/                         # bug_platform(mock/jira/zentao)、env_executor
│                                     #   (local/ssh/docker)、csv_import、registry、
│                                     #   claude_code_cli、notifier(_im)、whitelist
├── perception/                       # 三维感知（FR-FIX-02）
├── services/                         # llm_gateway(fake/anthropic+计量预算)、intervention、
│                                     #   env_lock、scheduler、optimization、experience、
│                                     #   export、importer、ingestion、audit、writeback
├── security/                         # Fernet 凭据、注入防护、脱敏
├── prompts/                          # 版本化提示词模板
├── api/ + web/                       # FastAPI 对内接口 + 静态控制台
└── cli.py / scheduler_cli.py / export_cli.py
tests/                                # 144 条用例（单元 + 端到端 + API）
examples/bugs_sample.csv              # 中文示例 CSV（utf-8-sig）
docs/                                 # PRD 与整体方案设计
```

## 说明

- 默认 `llm_mode=fake`：结构化分析（完整性/方案/评分/失败分析）与修复 agent 均为脚本化应答，供 CI 与本地开发；切真实模式设 `LLM_MODE=anthropic` 并配置 Key。
- 设计依据：`docs/` 下 PRD 与整体方案设计（状态机见 3.1、数据模型 5.1、接口 6.1、补充设计 11.1~11.6）。
