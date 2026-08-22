"""评分 v2 本地映射器与代码实证（Spec 04 §8.2/§8.4/§8.6）。

链路：AI 判定表单（引用标准条目 ID，不输出分数）→ 本地常量映射器
（类型基准 + 因子修正 → 四维分：定位/修改/验证/波及）→ 策略版本加权 → 阈值准入。

代码实证（复杂类型触发）：从**全部关联仓库**（Spec 01 §9）只读检索相关文件片段，
第二次 LLM 调用产出实证结论，驱动定位/波及维度。仓库可用性已由接入层前置保证，
**不存在"无仓库降级"分支**（Spec 04 §8.6）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from autobugfixer.core.models import BugRepo
from ..prompts.rubric import Rubric
from autobugfixer.scoring.schemas import CodeEvidence, JudgmentForm

# 触发代码实证的复杂类型（Spec 04 §8.6）
CODE_EVIDENCE_TYPES = {"cross_module", "data_arch"}

# 实证检索限制（token 限量）
_MAX_SNIPPETS = 8
_MAX_SNIPPET_CHARS = 200
_MAX_FILE_BYTES = 200_000
_SKIP_DIRS = {".git", ".baseline", "node_modules", "__pycache__", ".venv"}
_SKIP_SUFFIXES = {".png", ".jpg", ".gif", ".zip", ".gz", ".tar", ".db", ".bin", ".exe"}

DB_ACTIONS = {"query_db", "assert_db"}


@dataclass(frozen=True)
class Dims:
    """四维分（Spec 04 §8.4：定位/修改/验证/波及），各 0-100。"""

    locate: float
    fix: float
    verify: float
    blast: float

    def as_dict(self) -> dict[str, float]:
        return {"locate": self.locate, "fix": self.fix,
                "verify": self.verify, "blast": self.blast}


def _clamp(value: float) -> float:
    return round(max(0.0, min(100.0, value)), 2)


def _row_mid(rows, key: str) -> float:
    row = next((r for r in rows if r.key == key), None)
    if row is None:
        raise ValueError(f"rubric 基准表缺少判定键: {key}")
    return row.range.mid


def _local_factors(affected_modules: list[str], plan_steps: list[dict]) -> set[str]:
    """local 判定者因子（纯本地规则，Spec 04 §8.3 修正因子表）。"""
    has_db = any(s.get("action") in DB_ACTIONS for s in plan_steps)
    hit = set()
    if len([m for m in affected_modules if m]) >= 2:
        hit.add("modules_ge_2")
    if has_db or len(plan_steps) >= 5:
        hit.add("plan_db_or_5steps")
    return hit


def _verify_row_key(plan_steps: list[dict]) -> str:
    """验证难度基准行选择（本地推导：步骤数/动作类型）。"""
    has_db = any(s.get("action") in DB_ACTIONS for s in plan_steps)
    n = len(plan_steps)
    if has_db or n > 5:
        return "steps_gt5_or_db"
    if n >= 3:
        return "steps_3_5"
    return "steps_lt3_no_db"


def map_judgment(rubric: Rubric, form: JudgmentForm, *,
                 affected_modules: list[str], plan_steps: list[dict],
                 code_evidence: CodeEvidence | None = None) -> Dims:
    """判定表单 + 本地输入 → 四维分（纯本地确定性，可逐项复算）。

    - 修改/波及：类型先验基准中点 + 对应维度因子修正；
    - 定位：locate_signals 选基准行（has_stack > has_location_desc > none）
      + 定位类因子修正；
    - 验证：方案复杂度本地推导选行 + 验证类因子修正；
    - 代码实证（复杂类型）：triggered → 定位 -10（已定位疑似点）；
      波及按 suspected_files 每文件 +5（上限 +20）。
    """
    prior = rubric.types.get(form.bug_type)
    if prior is None:
        raise ValueError(f"rubric 缺少类型: {form.bug_type}")

    hit_ids = _local_factors(affected_modules, plan_steps) | set(form.factors_hit)
    deltas = [rubric.factor(fid) for fid in hit_ids]
    deltas = [f for f in deltas if f is not None]  # 未知因子 ID 忽略（防御）

    locate = _row_mid(rubric.locate_rows,
                      "has_stack" if form.locate_signals.has_stack
                      else "has_location_desc" if form.locate_signals.has_location_desc
                      else "none")
    fix = prior.fix.mid
    blast = prior.blast.mid
    verify = _row_mid(rubric.verify_rows, _verify_row_key(plan_steps))
    for factor in deltas:
        if factor.dimension == "定位":
            locate += factor.delta
        elif factor.dimension == "修改":
            fix += factor.delta
        elif factor.dimension == "验证":
            verify += factor.delta
        else:
            blast += factor.delta

    evidence = code_evidence or form.code_evidence
    if evidence.triggered:
        locate -= 10
        blast += min(5 * len(evidence.suspected_files), 20)

    return Dims(locate=_clamp(locate), fix=_clamp(fix),
                verify=_clamp(verify), blast=_clamp(blast))


# ---- 代码实证只读检索（Spec 04 §8.6） ----


def extract_keywords(*texts: str, limit: int = 6) -> list[str]:
    """从文本提取检索关键词（字母数字/中文词元，>=2 字符）。"""
    tokens: list[str] = []
    for text in texts:
        tokens.extend(t for t in re.split(r"[^\w]+", text, flags=re.UNICODE) if len(t) >= 2)
    return tokens[:limit]


def search_repos(repo_rows: list[BugRepo], keywords: list[str]) -> list[str]:
    """全部关联仓库只读检索：返回命中文本片段（不建工作区、不触碰修复链路写权限）。"""
    snippets: list[str] = []
    if not keywords:
        return snippets
    lowered = [k.lower() for k in keywords]
    for repo in repo_rows:
        root = Path(repo.path)
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if len(snippets) >= _MAX_SNIPPETS:
                return snippets
            if (not path.is_file() or path.suffix.lower() in _SKIP_SUFFIXES
                    or _SKIP_DIRS & set(path.parts)):
                continue
            try:
                if path.stat().st_size > _MAX_FILE_BYTES:
                    continue
                content = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for line_no, line in enumerate(content.splitlines(), start=1):
                if any(k in line.lower() for k in lowered):
                    rel = path.relative_to(root)
                    snippets.append(f"{repo.branch}:{rel}:{line_no}: {line.strip()[:_MAX_SNIPPET_CHARS]}")
                    break  # 每文件只取首个命中行
    return snippets
