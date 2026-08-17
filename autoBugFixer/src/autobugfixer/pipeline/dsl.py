"""验证方案可执行 DSL（设计文档 11.4）。

动作词汇表为有限集合，验证执行器逐条解释执行；DSL 版本化（dsl_version）向后兼容。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Protocol

from pydantic import BaseModel, Field, field_validator

DSL_VERSION = "1.0"

# 动作词表（11.4）：动作 -> 必填参数
DSL_ACTIONS: dict[str, set[str]] = {
    "open_page": {"url"},
    "click": {"selector"},
    "input": {"selector", "value"},
    "assert_element": {"selector", "state"},
    "call_api": {"method", "path"},
    "assert_response": {"expect"},
    "query_db": {"sql"},
    "assert_db": {"sql", "expect"},
    "check_log": {"service", "pattern"},
}


class DSLStep(BaseModel):
    """单条 DSL 步骤：{"action": "call_api", "params": {...}}"""

    action: str
    params: dict[str, Any] = Field(default_factory=dict)
    desc: str = ""  # 可读描述（人工确认方案时展示）

    @field_validator("action")
    @classmethod
    def action_must_be_in_vocab(cls, v: str) -> str:
        """校验动作必须在 DSL_ACTIONS 词表内。"""
        if v not in DSL_ACTIONS:
            raise ValueError(f"非法 DSL 动作: {v}，允许: {sorted(DSL_ACTIONS)}")
        return v

    @field_validator("params")
    @classmethod
    def params_must_cover_required(cls, v: dict[str, Any], info) -> dict[str, Any]:
        """校验 params 覆盖该动作的必填参数。"""
        # action 校验先于 params 执行（按字段声明顺序）
        action = info.data.get("action")
        if action in DSL_ACTIONS:
            missing = DSL_ACTIONS[action] - v.keys()
            if missing:
                raise ValueError(f"动作 {action} 缺少必填参数: {sorted(missing)}")
        return v


@dataclass
class StepResult:
    """单步验证结果（通过/失败 + 详情 + 证据摘要）。"""

    action: str
    passed: bool
    detail: str = ""
    evidence: str = ""  # 证据摘要（页面片段/响应体/日志行）


class DSLRuntime(Protocol):
    """DSL 解释执行器依赖的运行时能力（由 EnvExecutor 提供）。"""

    def read_text(self, rel_path: str) -> str | None:
        """读取环境内文件文本。"""
        ...

    def query_db(self, sql: str) -> list[dict]:
        """执行只读 SQL 返回行列表。"""
        ...


def _json_path_get(obj: Any, path: str) -> Any:
    """极简 json path：dotted 形式 a.b.c。"""
    for part in path.split("."):
        if isinstance(obj, dict) and part in obj:
            obj = obj[part]
        else:
            raise KeyError(path)
    return obj


def _check_readonly_sql(sql: str) -> None:
    """数据检查只允许只读 SQL（11.4 query_db/assert_db 白名单）。"""
    if not re.match(r"^\s*select\b", sql, re.IGNORECASE):
        raise ValueError(f"仅允许只读 SELECT: {sql}")


class DSLInterpreter:
    """DSL 解释执行器：逐条执行验证步骤并产出证据链（FR-REG-03）。"""

    def __init__(self, runtime: DSLRuntime) -> None:
        self.runtime = runtime
        self._last_page: str = ""
        self._last_response: Any = None

    def execute(self, steps: list[DSLStep | dict]) -> list[StepResult]:
        """逐条执行验证步骤，返回每步结果（dict 自动转 DSLStep）。"""
        results: list[StepResult] = []
        for raw in steps:
            step = raw if isinstance(raw, DSLStep) else DSLStep.model_validate(raw)
            results.append(self._run_step(step))
        return results

    def _run_step(self, step: DSLStep) -> StepResult:
        handler = getattr(self, f"_do_{step.action}", None)
        if handler is None:
            return StepResult(step.action, False, f"执行器不支持动作: {step.action}")
        try:
            return handler(**step.params)
        except Exception as exc:
            return StepResult(step.action, False, f"执行异常: {exc}")

    # ---- 页面类（本地仿真：url 映射到环境目录下 pages/ 文件） ----

    def _do_open_page(self, url: str) -> StepResult:
        rel = "pages/" + url.lstrip("/").replace("/", "_") + ".html"
        content = self.runtime.read_text(rel)
        if content is None:
            return StepResult("open_page", False, f"页面不存在: {rel}")
        self._last_page = content
        return StepResult("open_page", True, f"已打开 {url}", evidence=content[:200])

    def _do_click(self, selector: str) -> StepResult:
        # 本地仿真不驱动真实浏览器，仅记录交互（P1 接 Playwright）
        return StepResult("click", True, f"模拟点击 {selector}")

    def _do_input(self, selector: str, value: str = "") -> StepResult:
        return StepResult("input", True, f"模拟输入 {selector}={value}")

    def _do_assert_element(self, selector: str, state: str = "present") -> StepResult:
        found = selector in self._last_page
        if state == "present":
            ok = found
        elif state == "absent":
            ok = not found
        elif state.startswith("text:"):
            ok = state[5:] in self._last_page
        else:
            return StepResult("assert_element", False, f"未知 state: {state}")
        return StepResult("assert_element", ok, f"selector={selector} state={state}",
                          evidence=self._last_page[:200])

    # ---- 接口类（本地仿真：path 映射到环境目录下 api/ 的 JSON 文件） ----

    def _do_call_api(self, method: str, path: str, body: dict | None = None,
                     headers: dict | None = None) -> StepResult:
        rel = "api/" + path.lstrip("/").replace("/", "_") + ".json"
        content = self.runtime.read_text(rel)
        if content is None:
            return StepResult("call_api", False, f"接口无响应: {method} {path}")
        try:
            self._last_response = json.loads(content)
        except json.JSONDecodeError:
            self._last_response = {"_raw": content}
        return StepResult("call_api", True, f"{method} {path}", evidence=content[:200])

    def _do_assert_response(self, expect: Any, status: int | None = None,
                            json_path: str | None = None) -> StepResult:
        if self._last_response is None:
            return StepResult("assert_response", False, "尚未调用接口")
        try:
            if json_path:
                actual = _json_path_get(self._last_response, json_path)
            else:
                actual = self._last_response
        except KeyError:
            return StepResult("assert_response", False, f"json_path 不存在: {json_path}",
                              evidence=json.dumps(self._last_response, ensure_ascii=False)[:200])
        if status is not None and isinstance(self._last_response, dict):
            http_status = self._last_response.get("http_status", status)
            if http_status != status:
                return StepResult("assert_response", False, f"http 状态 {http_status} != {status}")
        ok = actual == expect
        return StepResult("assert_response", ok, f"实际={actual!r} 预期={expect!r}")

    # ---- 数据类（只读 SQL 白名单） ----

    def _do_query_db(self, sql: str) -> StepResult:
        _check_readonly_sql(sql)
        rows = self.runtime.query_db(sql)
        self._last_response = rows
        return StepResult("query_db", True, f"返回 {len(rows)} 行",
                          evidence=json.dumps(rows, ensure_ascii=False)[:200])

    def _do_assert_db(self, sql: str, expect: str) -> StepResult:
        _check_readonly_sql(sql)
        rows = self.runtime.query_db(sql)
        # expect 形式: "row_count>=1" 或 "field=value"（取首行）
        m = re.match(r"row_count(>=|<=|==|>|<)(\d+)", expect)
        if m:
            op, n = m.group(1), int(m.group(2))
            ops = {">=": len(rows) >= n, "<=": len(rows) <= n, "==": len(rows) == n,
                   ">": len(rows) > n, "<": len(rows) < n}
            ok = ops[op]
            return StepResult("assert_db", ok, f"row_count={len(rows)} 预期 {expect}")
        if "=" in expect:
            key, _, value = expect.partition("=")
            actual = str(rows[0].get(key.strip())) if rows else None
            ok = actual == value.strip()
            return StepResult("assert_db", ok, f"{key}={actual} 预期 {value}")
        return StepResult("assert_db", False, f"无法解析 expect: {expect}")

    # ---- 日志类 ----

    def _do_check_log(self, service: str, pattern: str, since: str = "",
                      absent: bool = False) -> StepResult:
        """检查日志命中：absent=false 命中数>0 才过；absent=true 反转为命中数==0（否定断言）。

        since 参数当前仅收不校（无时间窗过滤，Spec 07 §10 已知限制）。
        """
        content = self.runtime.read_text(f"logs/{service}.log")
        if content is None:
            return StepResult("check_log", False, f"日志不存在: {service}")
        matched = re.findall(pattern, content)
        ok = (len(matched) == 0) if absent else (len(matched) > 0)
        mode = "不出现" if absent else "出现"
        return StepResult("check_log", ok,
                          f"pattern={pattern} {mode}（命中 {len(matched)} 次）",
                          evidence=content[:200])
