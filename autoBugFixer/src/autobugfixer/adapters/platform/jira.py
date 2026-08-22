"""Jira Cloud REST 适配器（设计文档 6.2：BugPlatformAdapter 的真实实现）。

- 认证：Basic Auth（email + API token），``httpx.Client(auth=(email, token))``；
- 拉取：JQL 搜索（``/rest/api/3/search``）+ issue 详情（描述 ADF 转纯文本、
  附件元数据、自定义字段映射）；
- 回写：评论（ADF 文档）+ 状态流转（transitions 按名称解析）+ 自定义字段更新；
- 自定义字段 id 因 Jira 实例而异，通过 ``field_map`` 配置（BugTicketData 字段名 ->
  Jira 字段 id，如 ``{"repro_steps": "customfield_10010"}``）；未映射的字段留空，
  缺失关键字段由 ``BugTicketData.missing_fields`` 自动标记（沿用 ingestion 约定）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx

from autobugfixer.adapters.platform import BugPatch, BugTicketData


class JiraBugPlatform:
    """Jira Cloud 缺陷平台适配器。构造时可注入 ``client``（测试用 MockTransport）。"""

    platform = "jira"
    DEFAULT_FIELDS = ["summary", "description", "attachment", "labels", "components"]

    def __init__(
        self,
        base_url: str,
        email: str,
        api_token: str,
        *,
        jql: str = "type = Bug ORDER BY updated DESC",
        field_map: dict[str, str] | None = None,
        status_map: dict[str, str] | None = None,
        client: httpx.Client | None = None,
        timeout: float = 30.0,
    ) -> None:
        if client is None:
            client = httpx.Client(
                base_url=base_url.rstrip("/"),
                auth=(email, api_token),
                headers={"Accept": "application/json"},
                timeout=timeout,
            )
        self._client = client
        self.jql = jql
        self.field_map = dict(field_map or {})
        # 统一状态名 -> Jira transition 名（11.7：状态映射配置化）
        self.status_map = dict(status_map or {})

    # ---- BugPlatformAdapter 契约 ----

    def list_bugs(self, since: datetime | None = None) -> list[BugTicketData]:
        """JQL 搜索 Bug（可选增量过滤），逐条转为标准化数据对象。"""
        jql = self.jql
        if since is not None:
            aware = since if since.tzinfo else since.replace(tzinfo=timezone.utc)
            jql = f'{jql} AND updated >= "{aware.strftime("%Y/%m/%d %H:%M")}"'
        resp = self._client.get(
            "/rest/api/3/search",
            params={"jql": jql, "fields": ",".join(self._fields()), "maxResults": 100},
        )
        _raise(resp)
        return [self._to_ticket(issue) for issue in resp.json().get("issues", [])]

    def get_bug(self, bug_id: str) -> BugTicketData:
        """按 issue key 查询详情并转标准化数据对象。"""
        resp = self._client.get(
            f"/rest/api/3/issue/{bug_id}", params={"fields": ",".join(self._fields())}
        )
        _raise(resp)
        return self._to_ticket(resp.json())

    def update_bug(self, bug_id: str, patch: BugPatch) -> None:
        """回写：评论（ADF）+ 字段更新 + 状态流转（按 status_map 解析 transition 名）。"""
        if patch.comment:
            _raise(self._client.post(
                f"/rest/api/3/issue/{bug_id}/comment",
                json={"body": _text_to_adf(patch.comment)},
            ))
        if patch.fields:
            _raise(self._client.put(
                f"/rest/api/3/issue/{bug_id}", json={"fields": patch.fields}
            ))
        if patch.status:
            self._transition(bug_id, self.status_map.get(patch.status, patch.status))

    def close(self) -> None:
        """关闭底层 httpx 连接池。"""
        self._client.close()

    # ---- 内部 ----

    def _fields(self) -> list[str]:
        return sorted(set(self.DEFAULT_FIELDS) | set(self.field_map.values()))

    def _to_ticket(self, issue: dict) -> BugTicketData:
        fields = issue.get("fields") or {}
        custom = {name: _field_text(fields.get(fid)) for name, fid in self.field_map.items()}
        components = [c.get("name", "") for c in fields.get("components") or []]
        return BugTicketData(
            platform=self.platform,
            platform_bug_id=issue.get("key") or str(issue.get("id", "")),
            title=fields.get("summary") or "",
            description=_adf_to_text(fields.get("description")),
            repro_steps=custom.get("repro_steps", ""),
            expected=custom.get("expected", ""),
            actual=custom.get("actual", ""),
            env_version=custom.get("env_version", ""),
            attachments=[
                a.get("content") or a.get("filename", "")
                for a in fields.get("attachment") or []
            ],
            repo_url=custom.get("repo_url", ""),
            repo_branch=custom.get("repo_branch") or "main",
            affected_modules=components or list(fields.get("labels") or []),
            raw_payload=issue,
        )

    def _transition(self, bug_id: str, name: str) -> None:
        resp = self._client.get(f"/rest/api/3/issue/{bug_id}/transitions")
        _raise(resp)
        want = name.lower()
        for t in resp.json().get("transitions", []):
            names = {
                str(t.get("name", "")).lower(),
                str((t.get("to") or {}).get("name", "")).lower(),
            }
            if want in names:
                _raise(self._client.post(
                    f"/rest/api/3/issue/{bug_id}/transitions",
                    json={"transition": {"id": t["id"]}},
                ))
                return
        raise ValueError(f"Jira issue {bug_id} 无可用状态流转: {name}")


def _raise(resp: httpx.Response) -> None:
    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(f"Jira API 错误 {resp.status_code}: {resp.text[:300]}") from exc


def _field_text(value: Any) -> str:
    """自定义字段取值：字符串 / ADF 文档 / 数字 / None 统一转文本。"""
    if value is None:
        return ""
    if isinstance(value, dict):
        return _adf_to_text(value)
    return str(value).strip()


def _adf_to_text(node: Any) -> str:
    """Atlassian Document Format -> 纯文本（段落/标题等块级节点间换行）。"""
    if not node:
        return ""
    if isinstance(node, str):
        return node.strip()
    parts: list[str] = []

    def walk(n: Any) -> None:
        if isinstance(n, dict):
            if n.get("type") == "text":
                parts.append(n.get("text", ""))
            for child in n.get("content") or []:
                walk(child)
            if n.get("type") in ("paragraph", "heading", "codeBlock", "listItem"):
                parts.append("\n")
        elif isinstance(n, list):
            for child in n:
                walk(child)

    walk(node)
    return "".join(parts).strip()


def _text_to_adf(text: str) -> dict:
    """纯文本 -> 最小 ADF 文档（评论回写用）。"""
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]}
        ],
    }
