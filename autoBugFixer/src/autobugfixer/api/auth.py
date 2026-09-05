"""API 鉴权与 webhook 安全校验（P0-2 整改）。

- ``TokenAuthMiddleware``：配置 ``api_auth_token`` 后，除 ``/api/health`` 与
  静态资源外全部接口强制 ``Authorization: Bearer <token>`` 或
  ``X-API-Token: <token>``（恒时比较）；未配置 token 时放行（本地开发模式，
  生产由启动预检强制配置）。
- ``verify_webhook``：平台枚举白名单 + HMAC-SHA256 签名（或 token）校验 +
  请求体大小上限 + 进程内固定窗口限流。
"""

from __future__ import annotations

import hashlib
import hmac
import threading
import time

from fastapi import HTTPException, Request

# 免鉴权路径前缀（健康检查供探活；Web 控制台静态资源挂在非 /api 路径下）
_EXEMPT_PATHS = ("/api/health",)


class TokenAuthMiddleware:
    """ASGI 中间件：API Token 鉴权（token 未配置时不启用，保持本地开发零门槛）。"""

    def __init__(self, app, token: str | None) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not self.token:
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if any(path == exempt or path.startswith(exempt + "/") for exempt in _EXEMPT_PATHS):
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        presented = ""
        auth = headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            presented = auth[7:].strip()
        presented = presented or headers.get("x-api-token", "")
        if not hmac.compare_digest(presented, self.token):
            from starlette.responses import JSONResponse

            response = JSONResponse({"detail": "未授权：缺少或错误的 API Token"}, status_code=401)
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


class WebhookGuard:
    """webhook 受理守卫：平台白名单 + 签名校验 + 体积上限 + 固定窗口限流。

    限流为进程内存态（单实例部署口径，与 SQLite 单节点约束一致）；
    secret 未配置的平台不强制签名（本地/内网试点），配置即强制。
    """

    def __init__(self, settings) -> None:
        self.settings = settings
        self._lock = threading.Lock()
        self._hits: dict[tuple[str, int], int] = {}

    def check_platform(self, platform: str) -> None:
        """平台枚举白名单 + 生产模式禁 mock（伪造工单注入面）。"""
        allowed = self.settings.webhook_allowed_platforms
        if platform not in allowed:
            raise HTTPException(403, f"webhook 平台不在白名单: {platform!r}（可选 {allowed}）")
        if self.settings.production_mode and platform == "mock":
            raise HTTPException(403, "生产模式禁用 mock 平台 webhook（伪造工单注入面）")

    def check_rate(self, platform: str) -> None:
        """固定窗口限流：每平台每分钟至多 webhook_rate_limit_per_minute 次。"""
        limit = max(self.settings.webhook_rate_limit_per_minute, 1)
        window = int(time.time() // 60)
        with self._lock:
            # 顺手清理过期窗口（防 dict 无界增长）
            self._hits = {k: v for k, v in self._hits.items() if k[1] >= window - 1}
            count = self._hits.get((platform, window), 0)
            if count >= limit:
                raise HTTPException(429, f"webhook 触发限流（每分钟上限 {limit}）")
            self._hits[(platform, window)] = count + 1

    def check_body(self, body: bytes) -> None:
        """请求体大小上限（防超大 payload 打爆解析/入库）。"""
        limit = self.settings.webhook_max_body_bytes
        if len(body) > limit:
            raise HTTPException(413, f"webhook 请求体超过上限 {limit} 字节")

    def verify_signature(self, platform: str, body: bytes, request: Request) -> None:
        """签名校验：配置了 secret 的平台强制通过校验（HMAC-SHA256 hex 或 token）。"""
        secret = self.settings.webhook_secrets.get(platform)
        if not secret:
            return  # 未配置签名密钥的平台不强制（本地/内网试点）
        signature = request.headers.get("X-Webhook-Signature", "")
        if signature:
            expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
            if hmac.compare_digest(signature.strip().lower(), expected):
                return
            raise HTTPException(401, "webhook 签名校验失败（X-Webhook-Signature）")
        token = request.headers.get("X-Webhook-Token", "")
        if token and hmac.compare_digest(token, secret):
            return
        raise HTTPException(401, "webhook 缺少签名：提供 X-Webhook-Signature"
                                 "（HMAC-SHA256 hex of raw body）或 X-Webhook-Token")
