"""接口层感知（设计文档 4.2.2 接口维度）。

回放验证方案中的接口步骤（call_api/assert_response），
捕获异常状态码、错误报文与超时；httpx 实现，带超时与一次重试。
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from autobugfixer.common.dsl import DSLStep, _json_path_get  # 复用 DSL 的 json path 取值

from .base import (
    APICall,
    APIObservation,
    ObservationContext,
    PerceptionException,
)

API_ACTIONS = {"call_api", "assert_response"}

_MAX_ATTEMPTS = 2  # 超时/传输错误重试一次
_BODY_EXCERPT = 300


class APIPerception:
    """接口层感知适配器。"""

    dimension = "api"

    def __init__(
        self,
        base_url: str = "",
        timeout: float = 10.0,
        client: httpx.Client | None = None,  # 可注入（测试用 MockTransport）
    ) -> None:
        self.base_url = base_url
        self.timeout = timeout
        self._client = client

    def _http_client(self) -> httpx.Client:
        if self._client is not None:
            return self._client
        return httpx.Client(base_url=self.base_url, timeout=self.timeout)

    def observe(self, steps: list[DSLStep], ctx: ObservationContext) -> APIObservation | None:
        """回放接口步骤，捕获异常状态码、错误报文与超时（带一次重试）。"""
        api_steps = [s for s in steps if s.action in API_ACTIONS]
        if not api_steps:
            return None
        obs = APIObservation()
        client = self._http_client()
        last_response: httpx.Response | None = None
        last_json: Any = None
        for step in api_steps:
            if step.action == "call_api":
                last_response, last_json = self._do_call(client, step, obs)
            else:  # assert_response
                self._do_assert(step, obs, last_response, last_json)
        return obs

    # ---- 接口调用回放 ----

    def _do_call(
        self, client: httpx.Client, step: DSLStep, obs: APIObservation
    ) -> tuple[httpx.Response | None, Any]:
        p = step.params
        method, path = p["method"].upper(), p["path"]
        key = f"{method} {path}"
        attempts = 0
        start = time.monotonic()
        while True:
            attempts += 1
            try:
                resp = client.request(
                    method, path, json=p.get("body"), headers=p.get("headers"))
                break
            except httpx.TimeoutException as exc:
                if attempts < _MAX_ATTEMPTS:
                    continue  # 超时重试一次
                obs.calls.append(APICall(method=method, path=path, attempts=attempts,
                                         elapsed_ms=self._elapsed(start)))
                obs.exceptions.append(PerceptionException(
                    dimension="api", kind="timeout", key=key, detail=str(exc)[:200]))
                return None, None
            except httpx.HTTPError as exc:
                if attempts < _MAX_ATTEMPTS:
                    continue  # 传输错误重试一次
                obs.calls.append(APICall(method=method, path=path, attempts=attempts,
                                         elapsed_ms=self._elapsed(start)))
                obs.exceptions.append(PerceptionException(
                    dimension="api", kind="request_failed", key=key, detail=str(exc)[:200]))
                return None, None

        elapsed = self._elapsed(start)
        body_excerpt = resp.text[:_BODY_EXCERPT]
        obs.calls.append(APICall(method=method, path=path, status_code=resp.status_code,
                                 elapsed_ms=elapsed, attempts=attempts,
                                 body_excerpt=body_excerpt if resp.status_code >= 400 else ""))
        if resp.status_code >= 400:
            obs.exceptions.append(PerceptionException(
                dimension="api", kind="status_error", key=key,
                detail=f"HTTP {resp.status_code}: {body_excerpt}"))
        try:
            return resp, resp.json()
        except ValueError:
            return resp, {"_raw": resp.text}

    @staticmethod
    def _elapsed(start: float) -> float:
        return round((time.monotonic() - start) * 1000, 1)

    # ---- 响应断言（与 DSL assert_response 语义一致） ----

    def _do_assert(
        self, step: DSLStep, obs: APIObservation,
        last_response: httpx.Response | None, last_json: Any,
    ) -> None:
        p = step.params
        expect = p["expect"]
        key = f"assert_response expect={expect!r}"
        detail = ""
        ok = False
        if last_json is None:
            detail = "尚未调用接口"
        else:
            try:
                actual = _json_path_get(last_json, p["json_path"]) if p.get("json_path") else last_json
                ok = actual == expect
                detail = f"实际={actual!r} 预期={expect!r}"
            except KeyError:
                detail = f"json_path 不存在: {p.get('json_path')}"
            if ok and p.get("status") is not None and last_response is not None:
                ok = last_response.status_code == p["status"]
                detail = f"http 状态 {last_response.status_code} 预期 {p['status']}"
        if not ok:
            obs.exceptions.append(PerceptionException(
                dimension="api", kind="assert_failed", key=key, detail=detail))
