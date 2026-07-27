"""命令白名单校验器（FR-REG-01 / 11.2 执行侧）。

白名单为命令模板（如 "systemctl restart {service}"），执行前校验，
模板之外或参数含危险字符的命令直接拒绝；全部校验结果由调用方写审计。
"""

from __future__ import annotations

import re
import shlex

# 参数允许字符：字母数字与常见路径/版本符号，禁止 shell 元字符（防拼接注入）
_SAFE_ARG = re.compile(r"^[\w./:=@+-]+$", re.UNICODE)


def _template_to_regex(template: str) -> re.Pattern:
    """把 "tail -n {n} {log}" 这类模板编译为逐段匹配的正则。"""
    parts = shlex.split(template)
    pattern_parts = []
    for part in parts:
        if part.startswith("{") and part.endswith("}"):
            pattern_parts.append(r"(\S+)")  # 参数占位：单个非空白词
        else:
            pattern_parts.append(re.escape(part))
    return re.compile(r"^" + r"\s+".join(pattern_parts) + r"$")


class CommandWhitelist:
    def __init__(self, templates: list[str]) -> None:
        self.templates = list(templates)
        self._compiled = [_template_to_regex(t) for t in self.templates]

    def is_allowed(self, cmd: str) -> bool:
        cmd = cmd.strip()
        if not cmd:
            return False
        # 显式拒绝 shell 控制符，任何模板都不应匹配到它们
        if re.search(r"[;&|`$<>\\\n]", cmd):
            return False
        for pattern in self._compiled:
            m = pattern.match(cmd)
            if m and all(_SAFE_ARG.match(arg) for arg in m.groups()):
                return True
        return False

    def assert_allowed(self, cmd: str) -> None:
        if not self.is_allowed(cmd):
            raise CommandRejectedError(f"命令不在白名单内: {cmd}")


class CommandRejectedError(PermissionError):
    """命令被白名单拒绝。"""
