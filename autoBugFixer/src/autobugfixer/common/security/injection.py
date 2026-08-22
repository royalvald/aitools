"""提示词注入防护（设计文档 11.2，输入侧）。

- 外部文本进入 prompt 前统一包裹 untrusted 边界标记；
- 对明显注入模式做规则检测并留痕（不阻断，由审计记录告警）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

UNTRUSTED_OPEN = "<untrusted_bug_data>"
UNTRUSTED_CLOSE = "</untrusted_bug_data>"

# 常见注入模式（中英）
INJECTION_PATTERNS: list[re.Pattern] = [
    re.compile(r"ignore (all |any )?(previous|above|prior) instructions?", re.IGNORECASE),
    re.compile(r"disregard (all |any )?(previous|above) ", re.IGNORECASE),
    re.compile(r"忽略.*(指令|指示|命令|提示词?)"),
    re.compile(r"you are now|act as|system prompt", re.IGNORECASE),
    re.compile(r"rm -rf|del /[fqs]", re.IGNORECASE),
    re.compile(r"</?system>|<\|im_start\|>", re.IGNORECASE),
]


def wrap_untrusted(text: str) -> str:
    """外部输入统一包裹边界标记，系统指令声明边界内为数据而非指令。"""
    # 防止文本内伪造闭合标记逃逸边界
    safe = text.replace(UNTRUSTED_CLOSE, "< /untrusted_bug_data>")
    return f"{UNTRUSTED_OPEN}\n{safe}\n{UNTRUSTED_CLOSE}"


@dataclass
class InjectionReport:
    flagged: bool = False
    matched_patterns: list[str] = field(default_factory=list)


def detect_injection(text: str) -> InjectionReport:
    """检测明显注入模式。命中不阻断，返回报告供审计留痕。"""
    matched = [p.pattern for p in INJECTION_PATTERNS if p.search(text)]
    return InjectionReport(flagged=bool(matched), matched_patterns=matched)
