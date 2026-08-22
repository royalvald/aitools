# Spec 01 · CSV 数据接入（第一阶段）

| 项 | 值 |
|---|---|
| 范围 | **仅 CSV 批量导入**（Jira/禅道/webhook 为后续版本，见 §8） |
| 源码 | `ingest/csv_import.py`（解析）、`ingest/ingestion.py`（入库）、`ingest/importer.py`（导入编排）、`cli.py` / `api/routes.py`（入口） |
| 参考样例 | `examples/bugs_sample.csv`（本文所有示例均取自该文件，预期结果可实际复现） |

## 1. 目标与结果预期

把测试团队从 Excel 导出的中文 CSV **批量转换**为系统标准 Bug 数据并创建任务实例。

可衡量的结果预期：

| # | 预期 | 验证方式 |
|---|---|---|
| R1 | 合法 CSV 的每一数据行 → 1 条标准 `BugTicketData` + 1 个 `ANALYZING` 状态的任务 | 导入汇总 `imported` 计数 |
| R2 | 同一文件重复导入 → 0 个新任务（幂等） | 二次导入 `skipped` 计数 |
| R3 | 非法行（编号/标题为空）→ 记录`行号+原因`跳过，其余行照常导入 | 汇总 `failed` 列表 |
| R4 | 关键信息缺失的行不失败，但带 `missing_fields` 标记进入后续评估 | `task_ingest` 审计 |
| R5 | `--run-analysis` 时每个 Bug 得到明确分析终点（入队/待补充/转人工/待确认），**不启动修复** | 分析汇总 `admission` 字段 |
| R6 | **（P1 已实现）**每个 Bug 接入时关联其修复涉及的全部本地仓库并逐个校验可用性；任一缺失/不可用 → 任务停 `WAIT_INFO` 并自动发起仓库补充询问，**不消耗 LLM 成本** | `task_ingest` 审计 `repo_check` + 介入单（§9） |

## 2. 输入契约（CSV 文件格式）

**场景**：接入真实缺陷平台前的过渡方案，测试团队用 Excel 另存 CSV 批量导入。

| 约束 | 规格 |
|---|---|
| 编码 | UTF-8（可含 BOM）或 GBK（Excel 中文默认） |
| 结构 | 第 1 行为列头，第 2 行起为数据 |
| 必填列 | `bug_id`、`title` 两列必须存在（按别名识别），否则整文件拒收 |
| 单元格 | 引号包裹的单元格可含换行、逗号（csv 标准语法）；纯空白行忽略 |

**列头别名表**（识别时忽略大小写与首尾空白；未识别的列直接忽略不报错）：

| 标准字段 | 允许列头 |
|---|---|
| `bug_id`（必填列） | bug_id / bugid / id / 编号 / 缺陷编号 / bug编号 |
| `title`（必填列） | title / summary / 标题 / 缺陷标题 |
| `description` | description / desc / 描述 / 缺陷描述 / 问题描述 |
| `repro_steps` | repro_steps / steps / 复现步骤 / 重现步骤 |
| `expected` | expected / expected_result / 期望结果 / 预期结果 |
| `actual` | actual / actual_result / 实际结果 |
| `env_version` | env_version / environment / version / 环境版本 / 环境 / 版本 |
| `attachments` | attachments / attachment / 附件 |
| `repo_url` | repo_url / repo / 仓库 / 仓库地址 / 代码仓库 |
| `repo_branch` | repo_branch / branch / 分支 |

**标准样例**（`examples/bugs_sample.csv` 前 2 行，含引号多行单元格）：

```csv
缺陷编号,标题,描述,复现步骤,期望结果,实际结果,环境版本,附件,仓库地址,分支
BUG-2001,健康检查接口返回 fail,测试环境 /health 接口返回 status=fail，应为 ok,"1. 部署应用
2. 调用 GET /health
3. 观察返回 status 字段",status 为 ok,status 为 fail,v1.2.0 / python3.11,logs/health.log;,,
```

## 3. 行为规格

### B1 编码解码

| 规则 | 输入 | 预期结果 |
|---|---|---|
| B1-1 | UTF-8 带 BOM 字节流（Excel"CSV UTF-8"导出） | BOM 剥离后正确解码 |
| B1-2 | GBK 字节流（Excel 中文默认导出） | UTF-8 解码失败后按 GBK 解码成功 |
| B1-3 | 两种编码均无法解码 | 抛 `UnicodeDecodeError`，导入终止 |

### B2 列头识别与映射

| 规则 | 输入 | 预期结果 |
|---|---|---|
| B2-1 | 列头 `缺陷编号,标题,描述,...` | 逐列映射为 `bug_id,title,description,...`（列序无关，按别名识别） |
| B2-2 | 存在别名表外的列（如"严重程度"） | 该列忽略，不报错 |
| B2-3 | 缺 `bug_id` 或 `title` 任一必填列 | 抛 `CsvFormatError("CSV 缺少必填列: ['bug_id']")`，**整文件拒收**（文件级失败，无部分导入） |
| B2-4 | 文件仅空行 | 抛 `CsvFormatError("CSV 内容为空")` |

### B3 行级筛选（数据行从第 2 行计）

| 规则 | 输入 | 预期结果 |
|---|---|---|
| B3-1 | 某行 `bug_id` 为空 | 记入 `failures: [{row: N, reason: "bug_id 为空"}]`，该行跳过，**继续处理后续行** |
| B3-2 | 某行 `title` 为空 | 同上，`reason: "title 为空"` |
| B3-3 | 其余字段为空 | **不算失败**（进入 B5 标记） |
| B3-4 | 整行所有单元格空白 | 静默跳过，不计入 total 也不计失败 |

### B4 字段转换

| 规则 | 输入（单元格原文） | 输出（DTO 字段） |
|---|---|---|
| B4-1 | 所有单元格首尾空白 | 一律 `strip()` |
| B4-2 | 附件 `logs/health.log;screenshot.png;` | `["logs/health.log", "screenshot.png"]`（按 `;` 切分、去空项；仅保留标识，不下载内容） |
| B4-3 | 分支为空 | `repo_branch = "main"` |
| B4-4 | 引号内多行文本（如 BUG-2001 复现步骤） | 保留为含换行的完整字符串 `"1. 部署应用\n2. 调用 GET /health\n3. 观察返回 status 字段"` |

### B5 数据完整性标记（初步筛选，不失败）

**规则**：`title / description / repro_steps / expected / actual / env_version` 六字段任一为空 → 计入 `missing_fields`，随数据携带；**本阶段不做任何语义判断**（内容是否有意义由下一阶段评估），也不因缺失阻断导入。

（as-built：`repo_url`/`repo_branch` **不参与**上述判空——仓库字段现状零校验，目标要求见 §9。）

**实例**（样例文件第 5 行）：

```
输入: BUG-2002,首页打开白屏,用户反馈打开首页白屏，需要补充复现信息,,,,,screenshot.png;,,
预期: missing_fields = ["repro_steps", "expected", "actual", "env_version"]
      （title/description 非空，不计入）
```

### B6 入库与幂等

幂等键：`(platform="csv", platform_bug_id)`。

| 规则 | 场景 | 预期结果 |
|---|---|---|
| B6-1 | 首次导入某 bug_id | 建 `BugTicket` + `Task(state=ANALYZING, max_retry=3)`；写两条状态历史 `null→DISCOVERED→ANALYZING`；审计 `task_ingest`（含 missing_fields）；`created=True` |
| B6-2 | 重复导入相同数据 | 不新建不刷新，`created=False`（计入 skipped） |
| B6-3 | 重新导入且字段有实质变化 | 刷新 BugTicket 业务字段与 `synced_at`；任务状态不变 |
| B6-4 | 同 B6-3 且任务正处 `WAIT_INFO`（等待补充信息） | 自动唤醒：`WAIT_INFO → ANALYZING`，`info_rounds +1`，自动关闭待处理的信息补充介入单（平台回流等价于人工补充） |

### B7 导入编排与可选分析

入口：CLI `autobugfixer-import <file> [--run-analysis]` / API `POST /import/csv`（multipart：file、platform、run_analysis）。

1. **解析**（§B1-B5）→ **逐行入库**（§B6）→ 产出导入汇总并审计 `csv_import`：

```json
{"total": 4, "imported": 4, "skipped": 0,
 "failed": [{"row": 6, "reason": "bug_id 为空"}], "task_ids": [1, 2, 3, 4]}
```

（`total = imported + skipped + len(failed)` 行数）

2. **`--run-analysis` 时**：对本次**新建**的任务依次跑预处理三阶段（完整性→方案→评分），**停在 SCORED 不进入修复**。每任务产出分析结论：

```json
{"task_id": 1, "bug_id": "BUG-2001", "title": "健康检查接口返回 fail",
 "complete": true, "risk_level": "low",
 "scores": {"fix_difficulty": 20, "verify_difficulty": 15, "change_scale": 10},
 "priority_score": 15.5, "state": "SCORED", "admission": "入队"}
```

## 4. 样例文件完整预期结果

对 `examples/bugs_sample.csv` 执行导入 `--run-analysis`（Fake LLM 模式）：

| 行 | bug_id | 解析 | missing_fields | 分析终点 | admission |
|---|---|---|---|---|---|
| 2-4 | BUG-2001 | 成功（多行单元格正确拼接） | `[]` | `SCORED` | 入队（15.5 分 < 阈值 60） |
| 5 | BUG-2002 | 成功 | `[repro_steps, expected, actual, env_version]` | `WAIT_INFO` | 待补充（规则判空直接触发，不耗 LLM） |
| 6-8 | BUG-2003 | 成功（含引号逗号标题） | `[]` | `SCORED` | 入队（CSV 无影响模块列 → 不判高风险） |
| 9 | BUG-2004 | 成功 | `[]` | `SCORED` | 入队 |

导入汇总：`total=4, imported=4, skipped=0, failed=[]`；再次导入同一文件：`imported=0, skipped=4`。

## 5. 异常场景表

| 场景 | 输入 | 行为 | 预期结果 |
|---|---|---|---|
| 编码非法 | 任意非 UTF-8/GBK 字节 | 抛异常 | 导入终止，CLI/API 返回明确错误 |
| 空文件 | 仅空白行 | `CsvFormatError` | 整文件拒收 |
| 缺必填列 | 无"编号"列 | `CsvFormatError("CSV 缺少必填列: ['bug_id']")` | 整文件拒收 |
| 行级非法 | 某 bug_id 空 | 记 failures 跳过 | 该行不导入，其余行正常；`failed` 携带行号 |
| 附件空值 | 附件列 `;;` | 切分去空 | `attachments=[]` |
| 重复导入 | 同文件二次导入 | 幂等 | `skipped` 全计，无新任务 |
| 补全后重导 | BUG-2002 补全字段再导入（任务在 WAIT_INFO） | 刷新+唤醒 | 回 `ANALYZING` 重新评估，`info_rounds+1` |

## 6. 数据与审计留痕

| 表/审计 | 写入时机 | 关键内容 |
|---|---|---|
| `bug_ticket` | B6-1/B6-3 | 标准化字段、`missing_fields`、`raw_payload`（原文）、`synced_at` |
| `task` + `task_state_history` | B6-1 | `state=ANALYZING`、`max_retry=3`、初始两条历史 |
| 审计 `task_ingest` | B6-1 | platform、bug_id、missing_fields |
| 审计 `csv_import` | B7-1 | total/imported/skipped/failed 统计 |

## 7. 验收条款

| # | 条款（Given/When/Then） | 测试 |
|---|---|---|
| A1 | 给定 utf-8-sig 编码文件，当解析，则全部行正确转换 | `test_parse_utf8_sig` |
| A2 | 给定 GBK 编码文件，当解析，则解码成功且行正确转换 | `test_parse_gbk` |
| A3 | 给定含引号多行/逗号单元格与中文别名列头，当解析，则单元格与映射均正确 | `test_parse_quoted_multiline_and_comma` / `test_parse_alias_headers` |
| A4 | 给定缺必填列，当解析，则抛 `CsvFormatError` 且消息含缺失列名 | `test_parse_missing_required_column` |
| A5 | 给定 bug_id/title 为空的数据行，当解析，则记入 failures（含行号）且不中断 | `test_parse_empty_required_field_rows` |
| A6 | 给定缺关键字段的行，当解析，则 `missing_fields` 精确标记缺失清单 | `test_parse_missing_fields_marked` |
| A7 | 给定合法文件二次导入，当执行，则 `imported=0/skipped=N` 且任务数不变 | `test_import_result_structure_and_dedup` |
| A8 | 给定样例文件 `--run-analysis`，当执行，则 3 入队（15.5 分）+ 1 待补充，无任务进入 FIXING | `test_import_and_analysis_end_to_end` |
| A9 | 给定评分超阈值任务（脚本化高分），当分析，则 admission=转人工 | `test_analysis_high_score_to_manual` |
| A10 | 给定 API 上传合法/非法文件，当调用 `/import/csv`，则分别返回汇总/400 | `test_api_import_csv` / `test_api_import_csv_bad_format` |
| A11 | 给定 CLI 传入不存在文件，当执行，则报错退出非零 | `test_cli_bad_file` |

## 8. 第一阶段范围外（演进项）

- **Jira / 禅道平台轮询、webhook 事件接入**：转换规格（字段映射、ADF/HTML 解析、增量过滤）在接入真实平台时另行补充 spec；
- 附件内容下载（当前仅保留文件名/URL 标识）；
- CSV 行级失败行的内容快照回传、批量导入限流；
- 远程 git URL 仓库支持（按需 clone + 凭证管理 + ls-remote 验活）——本期仅认可本地目录路径，见 §9.7 决策记录。

## 9. 修复关联仓库要求（P1 目标规格 · 已实现）

> 状态：**已实现**（`ingest/repo_check.py`、`models.py::BugRepo`、完整性阶段门禁、`prepare_workspace` 改造）。本节由 Spec 04 §8.6（评分代码实证不允许"无仓库降级"）派生。

### 9.1 要求总则

Bug 接入时必须给出其修复可能涉及的**全部**本地代码仓库。接入层只做**可用性校验**，不判断"哪个仓库与缺陷相关"——相关仓库由后续 LLM 在全部关联仓库内自行定位与读取（评分代码实证见 Spec 04 §8.6；修复阶段的改动仓库判定见 Spec 05）。

| # | 要求 | 动机 |
|---|---|---|
| 1 | 每个 Bug 携带 ≥1 个关联仓库（可多个） | 修复工作区、代码实证都以真实源码为前提 |
| 2 | 接入时逐仓库校验可用性，结果持久化 | 评分/修复阶段默认仓库可用，无需降级分支 |
| 3 | 任一关联仓库缺失/不可用 → 照常入库，但任务在消耗 LLM 成本前被拦下，系统**主动询问**补全 | 越早拦截越省成本；不静默放弃也不静默降级 |
| 4 | 多仓库全量前置，不在接入层裁剪 | 相关性判定需要看代码，接入层无此能力 |

### 9.2 输入格式（CSV 列约定扩展）

| 规则 | 输入（仓库地址单元格） | 预期结果 |
|---|---|---|
| B9-1 | 单路径 `E:\repos\svc-a` | 关联 1 个仓库（与现状单值写法兼容） |
| B9-2 | 多路径 `;` 分隔，如 `E:\repos\svc-a;E:\repos\common`（与附件同一切分约定：strip、去空项） | 关联 2 个仓库，保持给定顺序 |
| B9-3 | 空值 | 关联 0 个仓库 → 按 B9-6 主动询问 |

分支列同样 `;` 分隔、**按位对应**各仓库；不足位补 `main`；整列空 = 全部 `main`。
例：仓库 2 个、分支单元格 `dev` → 分支序列 `[dev, main]`。

### 9.3 可用性校验（接入时逐仓库执行，纯本地检查、不耗 LLM）

| 规则 | 输入 | 预期结果 |
|---|---|---|
| B9-4 | 路径存在且为目录 | 继续判定仓库类型 |
| B9-5a | git 仓库（含 `.git`） | 验目标分支存在（`git rev-parse --verify`）→ 分支在 = 可用；分支缺 = 不可用（原因=分支缺失） |
| B9-5b | 非 git 目录 | 目录非空 = 可用；空目录 = 不可用（原因=空目录） |
| B9-5c | 路径不存在 / 指向文件 / 远程 URL（`http(s)://`、`git@`、`ssh://` 等） | 不可用（原因=路径不存在 / 非目录 / 远程地址本期不支持） |
| B9-6 | 任一关联仓库不可用（含 0 个关联） | **不拒收**；任务在进入分析前停 `WAIT_INFO`，自动创建 type=`repo_supplement` 介入单（系统主动询问，console 待办可办） |

校验结果逐仓库持久化（路径、分支、is_git、status、失败原因、checked_at），并随 `task_ingest` 审计携带 `repo_check` 摘要。

### 9.4 唤醒与复检

- **补全唤醒**：仓库信息补全后平台重导（复用 B6-3 字段刷新 + B6-4 `WAIT_INFO → ANALYZING` 唤醒），重新执行 §9.3 校验，全部可用才放行进入完整性分析。
- **接入后不复检**：任务进入修复前不重复校验；接入后目录被删等异常由修复阶段**显式失败**兜底——`prepare_workspace` 不再允许 `src=None` 静默建空工作区（见 §9.5/§9.6）。

### 9.5 数据结构与代码改造点（实现清单）

| 触点 | 现状 | 目标 |
|---|---|---|
| `BugTicket.repo_url / repo_branch` 单字段 | String 单值 | 多仓库关联结构（`bug_repo` 表：bug_ticket_id、path、branch、is_git、status、fail_reason、checked_at、seq；或等价 JSON 列），按序多值 |
| CSV 解析（B4） | 单值透传 | `;` 切分多仓库 + 分支按位对应（§9.2） |
| `ingest_bug` 接入服务 | 仓库字段直接落库、零校验 | 落库前执行 §9.3 校验；不可用 → `WAIT_INFO` + `repo_supplement` 介入单；**全部平台适配器（CSV/Jira/禅道）共用此逻辑** |
| `prepare_workspace` | `src=None` 时静默建空工作区 | 关联仓库 ≥1 且可用为前置条件；多仓库 → `workspace/<仓库名>/` 子目录布局（git 仓库逐个 worktree）；仓库不可用 → 修复阶段显式 FAILED |
| 评分代码实证（Spec 04 §8.6） | — | 只读检索范围为**全部关联仓库** |
| 介入类型 | `info_supplement` | 新增 `repo_supplement`（或复用 `info_supplement` 加 fields 标记，实现时定） |

### 9.6 现状对照（as-built，已随 §9 实现作废）

| 方面 | 当前实际行为 |
|---|---|
| 接入校验 | 无。`repo_url`/`repo_branch` 不在 B5 判空六字段内，空值照常入库、照常入队 |
| 样例 CSV | 4 行仓库地址列全空 → 全部照常入队（§4 预期即此行为） |
| 修复工作区 | `repo_url` 非本地存在目录（含空值 / 远程 URL / `mock://` 假地址）→ `src=None` → **建空工作区直接开修，不报错** |

### 9.7 决策记录

| 决策点 | 结论 |
|---|---|
| 缺失/不可用处置 | 系统主动询问（`WAIT_INFO` + 介入单），不拒收、不延迟到派发前 |
| 仓库地址形态 | 本期仅本地目录路径；远程 git URL 为演进项（§8） |
| 仓库数量 | 多仓库全量前置，不在接入层裁剪，由 LLM 自行读取定位 |
| 校验时机 | 接入时校验一次；修复前不复检，后续异常由修复阶段显式失败兜底 |
