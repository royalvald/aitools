"""敏感串脱敏（FR-SYS-03：知识库导出前剔除凭据、内部地址等敏感信息）。

P0-6 整改后作为全部落库路径的统一脱敏入口（audit detail、FixRecord
prompt/raw_log、部署步骤日志）：
- 赋值形式覆盖常见前缀（DB_PASSWORD=xxx / MY_API_TOKEN: xxx 等）；
- 覆盖 JSON 序列化形态（"api_key": "sk-..."，键值均带引号）；
- ``redact_value`` 递归处理 dict/list，字典键命中凭据名时直接掩码其值。
"""

from __future__ import annotations

import re

# 凭据类键名（含任意字母数字前缀，如 DB_/MONGO_/ADMIN_）：password/token/api_key 等
_CRED_KEY_BODY = (
    r"(?:[a-z0-9]+[_-])*(?:password|passwd|pwd|token|secret|"
    r"api[_-]?key|access[_-]?key)"
)
# 赋值形式：DB_PASSWORD=hunter2 / token: abc123 / --password=xxx
_CREDENTIAL_ASSIGN = re.compile(
    rf"(?i)\b({_CRED_KEY_BODY})(\s*[:=]\s*)([^\s,;\"']+)")
# JSON 序列化形式："api_key": "sk-999"（键值带引号，赋值正则吃不到值）
_CREDENTIAL_JSON = re.compile(
    rf'(?i)(("{_CRED_KEY_BODY}")(\s*:\s*)")([^"]*)(")')
# URL 内嵌凭据：scheme://user:pass@host
_URL_CREDENTIAL = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)([^/\s:@]+):([^/\s@]+)@")
# dict 键整键命中凭据名（redact_value 用：值直接掩码，不管值形态）
_CREDENTIAL_KEY_ONLY = re.compile(rf"(?i)^{_CRED_KEY_BODY}$")

MASK = "***"


def redact_sensitive(text: str) -> str:
    """脱敏：凭据赋值/JSON 键值与 URL 内嵌凭据打码。幂等、保守（宁多勿少）。"""
    text = _CREDENTIAL_ASSIGN.sub(lambda m: m.group(1) + m.group(2) + MASK, text)
    text = _CREDENTIAL_JSON.sub(lambda m: m.group(1) + MASK + m.group(5), text)
    text = _URL_CREDENTIAL.sub(lambda m: m.group(1) + MASK + "@", text)
    return text


def redact_value(obj):
    """递归脱敏任意 JSON 形态对象（dict/list/str 叶子过 redact_sensitive）。

    P0-6：审计 detail、FixRecord prompt/raw_log、cmd_exec 步骤日志等落库路径
    统一在写入前调用，防止 agent 读过 .env 类文件后凭据原样入库。
    dict 键本身命中凭据名（如 ``{"api_key": "sk-1"}``）时值直接掩码。
    """
    if isinstance(obj, str):
        return redact_sensitive(obj)
    if isinstance(obj, dict):
        return {redact_value(k): (_mask_if_credential_key(k, v) if v else redact_value(v))
                for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [redact_value(item) for item in obj]
    return obj


def _mask_if_credential_key(key, value):
    """键命中凭据名且值为非空字符串/数字时掩码值，否则递归脱敏。"""
    if isinstance(value, str) and _CREDENTIAL_KEY_ONLY.match(key.strip().strip('"')):
        return MASK
    return redact_value(value)
