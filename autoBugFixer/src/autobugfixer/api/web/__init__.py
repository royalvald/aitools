"""Web 控制台挂载（纯静态 SPA，无前端构建链）。

集成方式：在 create_app 完成 include_router 之后调用 ``mount_web(app)``。
- ``GET /``        -> static/index.html（FileResponse）
- ``/static/**``   -> static 目录（StaticFiles）

注意：本函数只新增 ``/`` 与 ``/static`` 两个路由，不覆盖已注册的 ``/api/**``。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

STATIC_DIR = Path(__file__).resolve().parent / "static"


def mount_web(app: FastAPI) -> None:
    """把静态控制台挂到 FastAPI 应用上（须在 include_router 之后调用）。"""
    if not STATIC_DIR.is_dir():
        raise RuntimeError(f"静态资源目录不存在: {STATIC_DIR}")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="web-static")

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        """返回控制台首页。"""
        return FileResponse(STATIC_DIR / "index.html")
