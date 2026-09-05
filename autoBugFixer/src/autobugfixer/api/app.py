"""FastAPI 应用组装：配置 -> 数据库 -> 适配器（registry）-> 编排器 -> Web 控制台。"""

from __future__ import annotations

import logging

from fastapi import FastAPI

from autobugfixer.adapters.platform import BugPlatformAdapter
from autobugfixer.features.fixing.driver import build_fix_driver, fix_driver_preflight
from autobugfixer.adapters.env import LocalExecutor
from autobugfixer.features.intervention.notifier_im import build_notifier
from autobugfixer.runtime.registry import get_bug_platform
from autobugfixer.adapters.env.whitelist import CommandWhitelist
from autobugfixer.api.auth import TokenAuthMiddleware, WebhookGuard
from autobugfixer.common.core.config import Settings, get_settings
from autobugfixer.common.core.db import init_db, make_engine, make_session_factory
from autobugfixer.common.core.logging_setup import setup_logging
from autobugfixer.runtime.orchestrator import Orchestrator
from autobugfixer.common.core.llm import LLMGateway, LLMPreflightError
from .routes import router

logger = logging.getLogger(__name__)


def _build_codex(settings: Settings):
    """按配置构建修复驱动（Spec 05：codex / deepseek / claude 由 fix_driver 决定）。"""
    return build_fix_driver(settings)


def _build_perception(settings: Settings, session_factory, executor):
    """按配置构建三维感知服务（默认关闭）。"""
    if not settings.perception_enabled:
        return None
    from autobugfixer.features.perception import APIPerception, DBPerception, PagePerception, PerceptionService

    return PerceptionService(
        session_factory,
        evidence_root=settings.perception_evidence_root,
        page=PagePerception(base_url=settings.perception_base_url),
        db=DBPerception(executor),
        api=APIPerception(base_url=settings.perception_base_url),
    )


def create_app(
    settings: Settings | None = None,
    platform: BugPlatformAdapter | None = None,
    codex=None,
) -> FastAPI:
    """组装 FastAPI 应用：建库、装配适配器与编排器、挂载路由与 Web 控制台。

    codex：测试可注入桩（ScriptedCodexCLI/自定义驱动）；缺省按 fix_driver 配置构建真实驱动。

    生产模式（production_mode=True，P0 整改）启动硬门槛：API Token 必配、
    FERNET_KEY 必配、webhook 白名单不得含 mock；缺一拒绝启动（本地开发不受影响）。
    """
    settings = settings or get_settings()
    _production_preflight(settings)
    engine = make_engine(settings.database_url)
    init_db(engine)
    # 感知模块自有表（checkfirst 幂等）
    from autobugfixer.features.perception.service import init_perception_db

    init_perception_db(engine)
    session_factory = make_session_factory(engine)

    whitelist = CommandWhitelist(settings.cmd_whitelist)
    executor = LocalExecutor(settings.env_root, whitelist)
    notifier = build_notifier(settings)
    llm = LLMGateway(settings, session_factory)
    # LLM 预检（Spec 02 B0）：静态配置错拒绝启动；探测失败降级运行（/health 暴露状态）
    preflight = llm.preflight()
    if not preflight.static_ok:
        raise LLMPreflightError(f"LLM 预检失败: {preflight.summary()}")
    if preflight.probe_error:
        logger.error("LLM 连通预检失败，服务降级启动（详见 /api/health）: %s",
                     preflight.probe_error)
    # 修复驱动预检（Spec 05 §2.2 扩展）：失败降级运行并在 /api/health 暴露
    # （查询/介入回写等非修复功能不受影响；修复任务将在 FIXING 显式 FAILED）
    codex_errors = fix_driver_preflight(settings)
    if codex_errors:
        logger.error("修复驱动预检失败（修复任务将失败，详见 /api/health）: %s",
                     "; ".join(codex_errors))
    # 平台适配器：显式传入优先，否则按配置名从 registry 实例化
    platform = platform or get_bug_platform(settings.bug_platform,
                                            settings.bug_platform_config)
    orchestrator = Orchestrator(
        session_factory, llm=llm, platform=platform,
        executor=executor, notifier=notifier, settings=settings,
        codex=codex if codex is not None else _build_codex(settings),
        perception=_build_perception(settings, session_factory, executor),
    )

    app = FastAPI(title="autobugfixer", version="0.1.0")
    # API Token 鉴权（P0-2）：token 已配置即强制（除 /api/health）；未配置=本地开发放行
    app.add_middleware(TokenAuthMiddleware, token=settings.api_auth_token)
    app.state.settings = settings
    app.state.session_factory = session_factory
    app.state.orchestrator = orchestrator
    app.state.llm_preflight = preflight
    app.state.codex_preflight = codex_errors
    app.state.webhook_guard = WebhookGuard(settings)
    app.include_router(router, prefix="/api")

    # Web 控制台（静态 SPA）：挂载在 API 路由之后
    from autobugfixer.api.web import mount_web

    mount_web(app)
    return app


def _production_preflight(settings: Settings) -> None:
    """生产模式启动硬门槛（P0 整改）：安全底线缺一拒绝启动。"""
    if not settings.production_mode:
        return
    errors: list[str] = []
    if not settings.api_auth_token:
        errors.append("生产模式未配置 API 鉴权：设置 AUTOBUGFIXER_API_AUTH_TOKEN")
    from autobugfixer.common.security.credentials import credential_preflight

    errors.extend(credential_preflight(settings))
    if "mock" in settings.webhook_allowed_platforms:
        errors.append("生产模式 webhook 平台白名单含 mock（伪造工单注入面）："
                      "设置 AUTOBUGFIXER_WEBHOOK_ALLOWED_PLATFORMS=[\"jira\",\"zentao\"]")
    if errors:
        raise RuntimeError("生产模式启动预检失败: " + "; ".join(errors))


def main() -> None:
    """CLI 入口：启动 uvicorn 服务（默认 127.0.0.1:8000）。"""
    import uvicorn

    setup_logging()
    uvicorn.run(create_app(), host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
