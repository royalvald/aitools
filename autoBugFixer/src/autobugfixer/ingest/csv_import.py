"""CSV Bug 导入解析（过渡方案：接入真实缺陷平台前，测试团队用 Excel 导出 CSV 批量导入）。

纯解析层：bytes -> BugTicketData 列表 + 失败行，不触碰数据库。
兼容 Excel 中文 CSV：UTF-8 带 BOM（utf-8-sig），失败兜底 GBK；
带引号单元格内的换行/逗号由 csv 模块正确解析。
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field

from autobugfixer.platform import BugTicketData

# 标准列头（第一行），映射到 BugTicket 字段
REQUIRED_COLUMNS = {"bug_id", "title"}

# 列名别名表：标准字段 -> 允许的列头（中英文，比较时忽略大小写与首尾空白）
COLUMN_ALIASES: dict[str, list[str]] = {
    "bug_id": ["bug_id", "bugid", "id", "编号", "缺陷编号", "bug编号"],
    "title": ["title", "summary", "标题", "缺陷标题"],
    "description": ["description", "desc", "描述", "缺陷描述", "问题描述"],
    "repro_steps": ["repro_steps", "steps", "复现步骤", "重现步骤"],
    "expected": ["expected", "expected_result", "期望结果", "预期结果"],
    "actual": ["actual", "actual_result", "实际结果"],
    "env_version": ["env_version", "environment", "version", "环境版本", "环境", "版本"],
    "attachments": ["attachments", "attachment", "附件"],
    "repo_url": ["repo_url", "repo", "仓库", "仓库地址", "代码仓库"],
    "repo_branch": ["repo_branch", "branch", "分支"],
}


class CsvFormatError(ValueError):
    """CSV 整体格式错误（空文件、缺必填列），此时无法逐行解析。"""


@dataclass
class RowFailure:
    """行级解析失败记录（行号 + 原因）。"""

    row: int  # CSV 行号（header 为第 1 行，数据从第 2 行起）
    reason: str


@dataclass
class ParseResult:
    """CSV 解析结果：成功行 + 失败行 + 表头。"""

    rows: list[BugTicketData] = field(default_factory=list)
    failures: list[RowFailure] = field(default_factory=list)
    headers: list[str] = field(default_factory=list)


def decode_csv(content: bytes) -> str:
    """Excel 中文 CSV 兼容：优先 UTF-8（含 BOM），失败兜底 GBK。"""
    try:
        return content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return content.decode("gbk")


def _map_headers(header: list[str]) -> dict[int, str]:
    """列序号 -> 标准字段名（按别名表匹配，未识别的列忽略）。"""
    mapping: dict[int, str] = {}
    for idx, name in enumerate(header):
        key = name.strip().lower()
        for field_name, aliases in COLUMN_ALIASES.items():
            if key in aliases:
                mapping[idx] = field_name
                break
    return mapping


def parse_csv(content: bytes, platform: str = "csv") -> ParseResult:
    """解析 CSV 字节流。缺必填列抛 CsvFormatError；行级错误记入 failures，不中断。"""
    text = decode_csv(content)
    reader = csv.reader(io.StringIO(text))
    raw_rows = [r for r in reader if any(cell.strip() for cell in r)]  # 跳过纯空行
    if not raw_rows:
        raise CsvFormatError("CSV 内容为空")

    mapping = _map_headers(raw_rows[0])
    missing = REQUIRED_COLUMNS - set(mapping.values())
    if missing:
        raise CsvFormatError(f"CSV 缺少必填列: {sorted(missing)}")

    result = ParseResult(headers=[h.strip() for h in raw_rows[0]])
    for row_no, raw in enumerate(raw_rows[1:], start=2):
        record = {field_name: (raw[idx].strip() if idx < len(raw) else "")
                  for idx, field_name in mapping.items()}
        bug_id = record.get("bug_id", "")
        title = record.get("title", "")
        if not bug_id:
            result.failures.append(RowFailure(row=row_no, reason="bug_id 为空"))
            continue
        if not title:
            result.failures.append(RowFailure(row=row_no, reason="title 为空"))
            continue
        attachments = [a.strip() for a in record.get("attachments", "").split(";") if a.strip()]
        result.rows.append(BugTicketData(
            platform=platform,
            platform_bug_id=bug_id,
            title=title,
            description=record.get("description", ""),
            repro_steps=record.get("repro_steps", ""),
            expected=record.get("expected", ""),
            actual=record.get("actual", ""),
            env_version=record.get("env_version", ""),
            attachments=attachments,
            repo_url=record.get("repo_url", ""),
            repo_branch=record.get("repo_branch", "") or "main",
        ))
    return result
