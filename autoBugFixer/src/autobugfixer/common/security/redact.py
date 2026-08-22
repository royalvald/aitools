"""敏感串脱敏（FR-SYS-03：知识库导出前剔除凭据、内部地址等敏感信息）。"""

from __future__ import annotations

import re

# 凭据类赋值串：password=xxx / token: xxx / api_key = xxx 等
_CREDENTIAL_ASSIGN = re.compile(
    r"(?i)\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)"
    r"(\s*[:=]\s*)([^\s,;\"']+)")
# URL 内嵌凭据：scheme://user:pass@host
_URL_CREDENTIAL = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)([^/\s:@]+):([^/\s@]+)@")

MASK = "***"


def redact_sensitive(text: str) -> str:
    """脱敏：凭据赋值与 URL 内嵌凭据打码。幂等、保守（宁多勿少）。"""
    text = _CREDENTIAL_ASSIGN.sub(lambda m: m.group(1) + m.group(2) + MASK, text)
    text = _URL_CREDENTIAL.sub(lambda m: m.group(1) + MASK + "@", text)
    return text
