"""页面层感知（设计文档 4.2.2 页面维度）。

按验证方案中的页面步骤（open_page/click/input/assert_element）回放，
捕获渲染异常、元素缺失、交互失效并截屏留证。

Playwright 惰性导入：缺包时降级为 httpx 抓取 HTML + 子串解析检查，
保证无重型依赖也能跑（降级模式无真实交互与截屏，仅做存在性检查）。
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

import httpx

from autobugfixer.pipeline.dsl import DSLStep

from .base import (
    ObservationContext,
    PageObservation,
    PerceptionException,
    StepObservation,
)

if TYPE_CHECKING:  # 仅为类型标注，运行时惰性导入
    pass

PAGE_ACTIONS = {"open_page", "click", "input", "assert_element"}


def _selector_in_html(selector: str, html: str) -> bool:
    """降级模式的元素存在性检查：id/class 选择器退化为子串匹配。"""
    if selector in html:
        return True
    return selector.lstrip("#.") in html


class PagePerception:
    """页面层感知适配器。"""

    dimension = "page"

    def __init__(
        self,
        base_url: str = "",
        client: httpx.Client | None = None,
        timeout: float = 15.0,
        force_fallback: bool = False,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client  # 可注入（测试用 MockTransport）
        self.timeout = timeout
        self.force_fallback = force_fallback

    def observe(self, steps: list[DSLStep], ctx: ObservationContext) -> PageObservation | None:
        page_steps = [s for s in steps if s.action in PAGE_ACTIONS]
        if not page_steps:
            return None
        if not self.force_fallback:
            obs = self._observe_playwright(page_steps, ctx)
            if obs is not None:
                return obs
        return self._observe_httpx(page_steps, ctx)

    # ---- Playwright 路径（惰性导入） ----

    def _observe_playwright(
        self, steps: list[DSLStep], ctx: ObservationContext
    ) -> PageObservation | None:
        try:
            from playwright.sync_api import Error as PWError  # noqa: N813
            from playwright.sync_api import sync_playwright
        except ImportError:
            return None  # 缺包降级 httpx

        obs = PageObservation(mode="playwright")
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page()
            page_errors: list[str] = []
            page.on("pageerror", lambda e: page_errors.append(str(e)))
            page.on("console", lambda m: page_errors.append(m.text) if m.type == "error" else None)
            try:
                for step in steps:
                    p = step.params
                    try:
                        if step.action == "open_page":
                            url = p["url"] if p["url"].startswith(("http://", "https://", "file://")) \
                                else self.base_url + p["url"]
                            resp = page.goto(url, timeout=int(self.timeout * 1000))
                            obs.url = url
                            obs.status_code = resp.status if resp else None
                            shot = ctx.evidence_dir / "page.png"
                            page.screenshot(path=str(shot), full_page=True)
                            obs.screenshot_uri = str(shot)
                            html_path = ctx.evidence_dir / "page.html"
                            html_path.write_text(page.content(), encoding="utf-8")
                            obs.html_uri = str(html_path)
                            obs.steps.append(StepObservation(
                                action="open_page", target=url, detail=f"status={obs.status_code}"))
                        elif step.action == "click":
                            page.click(p["selector"], timeout=int(self.timeout * 1000))
                            obs.steps.append(StepObservation(
                                action="click", target=p["selector"], detail="已点击"))
                        elif step.action == "input":
                            page.fill(p["selector"], str(p.get("value", "")))
                            obs.steps.append(StepObservation(
                                action="input", target=p["selector"], detail="已输入"))
                        elif step.action == "assert_element":
                            self._assert_element_pw(page, p, obs)
                    except PWError as exc:
                        kind = "interaction_failed" if step.action in ("click", "input") else "render_error"
                        obs.steps.append(StepObservation(
                            action=step.action, target=str(p), passed=False, detail=str(exc)[:300]))
                        obs.exceptions.append(PerceptionException(
                            dimension="page", kind=kind,
                            key=str(p.get("selector") or p.get("url") or ""),
                            detail=str(exc)[:300], evidence_uri=obs.screenshot_uri))
                for err in page_errors:
                    obs.exceptions.append(PerceptionException(
                        dimension="page", kind="render_error", key=obs.url,
                        detail=err[:300], evidence_uri=obs.screenshot_uri))
            finally:
                browser.close()
        return obs

    def _assert_element_pw(self, page, params: dict, obs: PageObservation) -> None:
        selector, state = params["selector"], params.get("state", "present")
        if state == "present":
            ok = page.query_selector(selector) is not None
        elif state == "absent":
            ok = page.query_selector(selector) is None
        elif state.startswith("text:"):
            ok = state[5:] in (page.text_content("body") or "")
        else:
            ok = False
        obs.steps.append(StepObservation(
            action="assert_element", target=selector, passed=ok, detail=f"state={state}"))
        if not ok:
            obs.exceptions.append(PerceptionException(
                dimension="page", kind="element_missing", key=selector,
                detail=f"断言失败 state={state}", evidence_uri=obs.screenshot_uri))

    # ---- httpx 降级路径 ----

    def _http_client(self) -> httpx.Client:
        if self._client is not None:
            return self._client
        return httpx.Client(base_url=self.base_url, timeout=self.timeout, follow_redirects=True)

    def _observe_httpx(self, steps: list[DSLStep], ctx: ObservationContext) -> PageObservation:
        obs = PageObservation(mode="httpx")
        html = ""
        client = self._http_client()
        for step in steps:
            p = step.params
            if step.action == "open_page":
                url = p["url"]
                obs.url = url
                try:
                    start = time.monotonic()
                    resp = client.get(url)
                    obs.status_code = resp.status_code
                    html = resp.text
                    obs.steps.append(StepObservation(
                        action="open_page", target=url, passed=resp.status_code < 400,
                        detail=f"status={resp.status_code} elapsed={time.monotonic() - start:.2f}s"))
                    html_path = ctx.evidence_dir / "page.html"
                    html_path.write_text(html, encoding="utf-8")
                    obs.html_uri = str(html_path)
                    if resp.status_code >= 400:
                        obs.exceptions.append(PerceptionException(
                            dimension="page", kind="render_error", key=url,
                            detail=f"页面响应状态 {resp.status_code}", evidence_uri=obs.html_uri))
                except httpx.HTTPError as exc:
                    obs.steps.append(StepObservation(
                        action="open_page", target=url, passed=False, detail=str(exc)[:300]))
                    obs.exceptions.append(PerceptionException(
                        dimension="page", kind="render_error", key=url, detail=str(exc)[:300]))
            elif step.action in ("click", "input"):
                # 降级模式无法真实交互，仅检查目标元素是否存在
                target = p["selector"]
                ok = bool(html) and _selector_in_html(target, html)
                obs.steps.append(StepObservation(
                    action=step.action, target=target, passed=ok,
                    detail="降级模式：仅存在性检查" + ("" if ok else "（元素缺失）")))
                if not ok:
                    obs.exceptions.append(PerceptionException(
                        dimension="page", kind="interaction_failed", key=target,
                        detail="交互目标元素缺失（httpx 降级模式）", evidence_uri=obs.html_uri))
            elif step.action == "assert_element":
                self._assert_element_http(p, html, obs)
        return obs

    def _assert_element_http(self, params: dict, html: str, obs: PageObservation) -> None:
        selector, state = params["selector"], params.get("state", "present")
        found = _selector_in_html(selector, html)
        if state == "present":
            ok = found
        elif state == "absent":
            ok = not found
        elif state.startswith("text:"):
            ok = state[5:] in html
        else:
            ok = False
        obs.steps.append(StepObservation(
            action="assert_element", target=selector, passed=ok, detail=f"state={state}"))
        if not ok:
            obs.exceptions.append(PerceptionException(
                dimension="page", kind="element_missing", key=selector,
                detail=f"断言失败 state={state}", evidence_uri=obs.html_uri))
