"""禅道（ZenTao）REST 适配器（设计文档 6.2：BugPlatformAdapter 的真实实现）。

走禅道开源版 ``/api.php/v1`` REST API：

- 登录：``POST /api.php/v1/tokens``（account + password）换取 token，
  后续请求带 ``Token`` 头；401 时自动重新登录一次；
- 拉取：``GET /api.php/v1/bugs`` 分页列表 + ``GET /api.php/v1/bugs/{id}`` 详情；
- 回写：状态流转走动作端点 ``POST /api.php/v1/bugs/{id}/{action}``
  （动作名通过 ``status_actions`` 配置，默认 resolved->resolve / closed->close /
  activated->activate / confirmed->confirm），备注随动作 ``comment`` 提交；
  仅备注/字段更新时走 ``PUT /api.php/v1/bugs/{id}``。

字段映射：禅道 Bug 无独立"描述"字段，复现步骤集中在 ``steps``（HTML，常含
``[步骤]/[结果]/[期望]`` 标记），解析后映射到 repro_steps/actual/expected；
``openedBuild`` 映射 env_version。无法映射的字段保留空值，由
``BugTicketData.missing_fields`` 自动标记（沿用 ingestion 约定）。
"""

from __future__ import annotations

import html
import re
from datetime import datetime
from typing import Any

import httpx

from . import BugPatch, BugTicketData

_STEP_MARK = {"步骤": "repro_steps", "结果": "actual", "期望": "expected"}


class ZentaoBugPlatform:
    """禅道缺陷平台适配器。构造时可注入 ``client``（测试用 MockTransport）。"""

    platform = "zentao"

    def __init__(
        self,
        base_url: str,
        account: str,
        password: str,
        *,
        product_id: int | None = None,
        status: str | None = None,
        status_actions: dict[str, str] | None = None,
        page_limit: int = 200,
        max_pages: int = 10,
        client: httpx.Client | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._client = client or httpx.Client(
            base_url=base_url.rstrip("/"), timeout=timeout
        )
        self._account = account
        self._password = password
        self.product_id = product_id
        self.status = status
        self.status_actions = {
            "resolved": "resolve",
            "closed": "close",
            "activated": "activate",
            "confirmed": "confirm",
            **dict(status_actions or {}),
        }
        self.page_limit = page_limit
        self.max_pages = max_pages
        self._token: str | None = None

    # ---- BugPlatformAdapter 契约 ----

    def list_bugs(self, since: datetime | None = None) -> list[BugTicketData]:
        """分页拉取 Bug 列表（可选按编辑/打开时间增量过滤）。"""
        bugs: list[dict] = []
        for page in range(1, self.max_pages + 1):
            params: dict[str, Any] = {"limit": self.page_limit, "page": page}
            if self.product_id is not None:
                params["product"] = self.product_id
            if self.status:
                params["status"] = self.status
            data = self._request("GET", "/api.php/v1/bugs", params=params).json()
            items = data.get("bugs") if isinstance(data, dict) else data
            items = items or []
            bugs.extend(items)
            if len(items) < self.page_limit:
                break
        if since is not None:
            threshold = since.strftime("%Y-%m-%d %H:%M:%S")
            bugs = [b for b in bugs if _bug_datetime(b) >= threshold]
        return [self._to_ticket(b) for b in bugs]

    def get_bug(self, bug_id: str) -> BugTicketData:
        """按 Bug id 查询详情并转标准化数据对象。"""
        data = self._request("GET", f"/api.php/v1/bugs/{bug_id}").json()
        if isinstance(data, dict) and isinstance(data.get("bug"), dict):
            data = data["bug"]
        return self._to_ticket(data)

    def update_bug(self, bug_id: str, patch: BugPatch) -> None:
        """回写：有状态映射走动作端点（带备注），否则 PUT 字段更新。"""
        body = dict(patch.fields)
        if patch.comment:
            body["comment"] = patch.comment
        if patch.status:
            action = self.status_actions.get(patch.status)
            if not action:
                raise ValueError(
                    f"未配置禅道状态动作映射: {patch.status}（status_actions 参数）"
                )
            self._request("POST", f"/api.php/v1/bugs/{bug_id}/{action}", json=body)
        elif body:
            self._request("PUT", f"/api.php/v1/bugs/{bug_id}", json=body)

    def close(self) -> None:
        """关闭底层 httpx 连接池。"""
        self._client.close()

    # ---- 内部 ----

    def _login(self) -> None:
        resp = self._client.post(
            "/api.php/v1/tokens",
            json={"account": self._account, "password": self._password},
        )
        _raise(resp)
        token = resp.json().get("token")
        if not token:
            raise RuntimeError("禅道登录响应缺少 token")
        self._token = token

    def _request(self, method: str, path: str, _retry: bool = True, **kwargs) -> httpx.Response:
        if self._token is None:
            self._login()
        resp = self._client.request(
            method, path, headers={"Token": self._token or ""}, **kwargs
        )
        if resp.status_code == 401 and _retry:
            self._token = None
            self._login()
            resp = self._client.request(
                method, path, headers={"Token": self._token or ""}, **kwargs
            )
        _raise(resp)
        return resp

    def _to_ticket(self, bug: dict) -> BugTicketData:
        parts = _split_steps(_html_to_text(str(bug.get("steps") or "")))
        files = bug.get("files")
        if isinstance(files, dict):
            files = list(files.values())
        module = bug.get("module")
        return BugTicketData(
            platform=self.platform,
            platform_bug_id=str(bug.get("id", "")),
            title=bug.get("title") or "",
            description="",  # 禅道 Bug 无独立描述字段，missing_fields 会标记
            repro_steps=parts["repro_steps"],
            expected=parts["expected"],
            actual=parts["actual"],
            env_version=_build_text(bug.get("openedBuild")),
            attachments=[
                str(f.get("title") or f.get("url") or "")
                for f in files or []
                if isinstance(f, dict)
            ],
            affected_modules=[str(module)] if module else [],
            raw_payload=bug,
        )


def _raise(resp: httpx.Response) -> None:
    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(f"禅道 API 错误 {resp.status_code}: {resp.text[:300]}") from exc


def _bug_datetime(bug: dict) -> str:
    """列表过滤用时间：取编辑/打开时间中较大者（忽略 0000-00-00 占位）。"""
    candidates = [
        str(bug.get(k) or "")
        for k in ("editedDate", "openedDate")
        if str(bug.get(k) or "") and not str(bug.get(k)).startswith("0000-")
    ]
    return max(candidates) if candidates else ""


def _build_text(value: Any) -> str:
    """openedBuild 取值：id / id 列表 / {id: name} 字典统一转文本。"""
    if not value:
        return ""
    if isinstance(value, dict):
        return ",".join(str(v) for v in value.values() if v)
    if isinstance(value, list):
        return ",".join(str(v) for v in value if v)
    return str(value)


def _html_to_text(text: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</p\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).strip()


def _split_steps(text: str) -> dict[str, str]:
    """按 [步骤]/[结果]/[期望] 标记切分；无标记时整体归入 repro_steps。"""
    out = {"repro_steps": "", "actual": "", "expected": ""}
    if not text:
        return out
    matches = list(re.finditer(r"\[(步骤|结果|期望)\]", text))
    if not matches:
        out["repro_steps"] = text
        return out
    if matches[0].start() > 0:
        out["repro_steps"] = text[: matches[0].start()].strip()
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        seg = text[m.end():end].strip()
        key = _STEP_MARK[m.group(1)]
        out[key] = f"{out[key]}\n{seg}".strip() if out[key] else seg
    return out
