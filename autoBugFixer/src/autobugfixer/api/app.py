"""FastAPI 应用组装：配置 -> 数据库 -> 适配器（registry）-> 编排器 -> Web 控制台。"""

from __future__ import annotations

from fastapi import FastAPI

from ..adapters.bug_platform import BugPlatformAdapter
from ..adapters.env_executor import LocalExecutor
from ..adapters.notifier_im import build_notifier
from ..adapters.registry import get_bug_platform
from ..adapters.whitelist import CommandWhitelist
from ..config import Settings, get_settings
from ..db import init_db, make_engine, make_session_factory
from ..logging_setup import setup_logging
from ..pipeline.orchestrator import Orchestrator
from ..services.llm_gateway import LLMGateway, MeteredFixChannel
from .routes import router


def _build_fix_channel(settings: Settings, llm: LLMGateway):
    """按配置构建修复通道：claude_code_cli 时包一层 llm_usage 计量。"""
    if settings.fix_channel == "claude_code_cli":
        from ..adapters.claude_code_cli import ClaudeCodeFixChannel

        channel = ClaudeCodeFixChannel(executable=settings.claude_executable,
                                       timeout=settings.claude_timeout)
        return MeteredFixChannel(channel, llm)
    return None  # langchain：直接用 LLMGateway 自带通道


def _build_perception(settings: Settings, session_factory, executor):
    """按配置构建三维感知服务（默认关闭）。"""
    if not settings.perception_enabled:
        return None
    from ..perception import APIPerception, DBPerception, PagePerception, PerceptionService

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
) -> FastAPI:
    settings = settings or get_settings()
    engine = make_engine(settings.database_url)
    init_db(engine)
    # 感知模块自有表（checkfirst 幂等）
    from ..perception.service import init_perception_db

    init_perception_db(engine)
    session_factory = make_session_factory(engine)

    whitelist = CommandWhitelist(settings.cmd_whitelist)
    executor = LocalExecutor(settings.env_root, whitelist)
    notifier = build_notifier(settings)
    llm = LLMGateway(settings, session_factory)
    # 平台适配器：显式传入优先，否则按配置名从 registry 实例化
    platform = platform or get_bug_platform(settings.bug_platform,
                                            settings.bug_platform_config)
    orchestrator = Orchestrator(
        session_factory, llm=llm, platform=platform,
        executor=executor, notifier=notifier, settings=settings,
        fix_channel=_build_fix_channel(settings, llm),
        perception=_build_perception(settings, session_factory, executor),
    )

    app = FastAPI(title="autobugfixer", version="0.1.0")
    app.state.settings = settings
    app.state.session_factory = session_factory
    app.state.orchestrator = orchestrator
    app.include_router(router, prefix="/api")

    # Web 控制台（静态 SPA）：挂载在 API 路由之后
    from ..web import mount_web

    mount_web(app)
    return app


def main() -> None:
    import uvicorn

    setup_logging()
    uvicorn.run(create_app(), host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
