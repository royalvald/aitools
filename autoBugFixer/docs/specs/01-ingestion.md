# Spec 01 · CSV 数据接入（第一阶段）

| 项 | 值 |
|---|---|
| 范围 | **仅 CSV 批量导入**（Jira/禅道/webhook 为后续版本，见 §8） |
| 源码 | `adapters/csv_import.py`（解析）、`services/ingestion.py`（入库）、`services/importer.py`（导入编排）、`cli.py` / `api/routes.py`（入口） |
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
- CSV 行级失败行的内容快照回传、批量导入限流。
