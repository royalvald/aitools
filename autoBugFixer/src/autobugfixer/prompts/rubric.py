"""评分评价标准（rubric）加载器（Spec 04 §8.3）。

固定表头 + 固定列序的 Markdown 表格解析；首行 ``rubric_version`` 为版本标识。
标准原文（``source_text``）运行时直传注入 prompt——标准变更只改 rubric 文件，
不动模板结构。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from importlib import resources

RUBRIC_VERSIONS = {
    "scoring_rubric": "v1",  # 版本治理：变更标准时必须升版本
}


@dataclass(frozen=True)
class Range:
    """数值区间（如 "5-15"），映射取中点。"""

    lo: float
    hi: float

    @property
    def mid(self) -> float:
        return (self.lo + self.hi) / 2


@dataclass(frozen=True)
class TypePrior:
    """缺陷类型先验行。"""

    id: str
    name: str
    features: str
    fix: Range
    blast: Range


@dataclass(frozen=True)
class Factor:
    """修正因子行（ai 判定 / local 本地规则）。"""

    id: str
    judge: str
    question: str
    dimension: str  # 定位/修改/验证/波及
    delta: float


@dataclass(frozen=True)
class KeyedRange:
    """带判定键的基准行（定位/验证表）：映射器按 key 选行。"""

    key: str
    desc: str
    range: Range


@dataclass(frozen=True)
class Rubric:
    """解析后的评价标准。"""

    version: str
    types: dict[str, TypePrior] = field(default_factory=dict)
    factors: list[Factor] = field(default_factory=list)
    locate_rows: list[KeyedRange] = field(default_factory=list)
    verify_rows: list[KeyedRange] = field(default_factory=list)
    source_text: str = ""

    def factor(self, factor_id: str) -> Factor | None:
        return next((f for f in self.factors if f.id == factor_id), None)


def _parse_range(text: str) -> Range:
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$", text)
    if not m:
        raise ValueError(f"无法解析基准区间: {text!r}")
    return Range(float(m.group(1)), float(m.group(2)))


def _parse_delta(text: str) -> float:
    return float(text.strip().replace("+", ""))


def _split_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _parse_table(lines: list[str]) -> tuple[list[list[str]], int]:
    """从当前偏移解析 Markdown 表格，返回 (数据行, 消耗行数含表头与分隔行)。

    首个非分隔行为表头（固定表头约定），丢弃；其余为数据行。
    """
    rows: list[list[str]] = []
    consumed = 0
    seen_header = False
    for line in lines:
        if not line.startswith("|"):
            break
        consumed += 1
        cells = _split_row(line)
        if all(re.fullmatch(r":?-{2,}:?", cell) for cell in cells):  # 分隔行
            continue
        if not seen_header:
            seen_header = True  # 表头行丢弃
            continue
        rows.append(cells)
    return rows, consumed


def parse_rubric(text: str) -> Rubric:
    """按固定表头解析 rubric 文本（段落标题 + Markdown 表格，容忍标题后空行）。"""
    m = re.search(r"rubric_version:\s*(\S+)", text)
    if not m:
        raise ValueError("rubric 缺少版本标识（首行 rubric_version:）")
    rubric = Rubric(version=m.group(1), source_text=text)
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("## "):
            section = line[3:].strip()
            j = i + 1
            while j < len(lines) and not lines[j].strip():  # 跳过标题后空行
                j += 1
            table, consumed = _parse_table(lines[j:])
            _fill_section(rubric, section, table)
            i = j + consumed
            continue
        i += 1
    if not rubric.types or not rubric.factors:
        raise ValueError("rubric 缺少类型先验表或修正因子表")
    return rubric


def _fill_section(rubric: Rubric, section: str, table: list[list[str]]) -> None:
    if section == "缺陷类型先验表":
        for cells in table:
            rubric.types[cells[0]] = TypePrior(
                id=cells[0], name=cells[1], features=cells[2],
                fix=_parse_range(cells[3]), blast=_parse_range(cells[4]))
    elif section == "修正因子表":
        for cells in table:
            rubric.factors.append(Factor(
                id=cells[0], judge=cells[1], question=cells[2],
                dimension=cells[3], delta=_parse_delta(cells[4])))
    elif section == "定位难度基准表":
        for cells in table:
            rubric.locate_rows.append(KeyedRange(
                key=cells[0], desc=cells[1], range=_parse_range(cells[2])))
    elif section == "验证难度基准表":
        for cells in table:
            rubric.verify_rows.append(KeyedRange(
                key=cells[0], desc=cells[1], range=_parse_range(cells[2])))


@lru_cache
def load_rubric(name: str = "scoring_rubric") -> Rubric:
    """加载打包的 rubric 文件（scoring_rubric -> rubrics/scoring_rubric_v1.md）。"""
    version = RUBRIC_VERSIONS[name]
    ref = resources.files("autobugfixer.prompts.rubrics").joinpath(f"{name}_{version}.md")
    return parse_rubric(ref.read_text(encoding="utf-8"))
