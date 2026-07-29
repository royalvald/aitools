"""调度器 CLI：autobugfixer-scheduler（常驻：轮询拉新/出队调度/超时回收/SLA 升级）。"""

from __future__ import annotations

import argparse

from .adapters.notifier_im import build_notifier
from .adapters.registry import get_bug_platform
from .adapters.env_executor import LocalExecutor
from .adapters.whitelist import CommandWhitelist
from .api.app import _build_fix_channel, _build_perception
from .config import Settings, get_settings
from .db import init_db, make_engine, make_session_factory
from .logging_setup import setup_logging
from .pipeline.orchestrator import Orchestrator
from .services.llm_gateway import LLMGateway
from .services.scheduler import Scheduler


def build_scheduler(settings: Settings | None = None) -> Scheduler:
    """组装调度器（测试可直接驱动 run_round，不跑死循环）。"""
    settings = settings or get_settings()
    engine = make_engine(settings.database_url)
    init_db(engine)
    session_factory = make_session_factory(engine)
    llm = LLMGateway(settings, session_factory)
    executor = LocalExecutor(settings.env_root, CommandWhitelist(settings.cmd_whitelist))
    notifier = build_notifier(settings)
    platform = get_bug_platform(settings.bug_platform, settings.bug_platform_config)
    orchestrator = Orchestrator(
        session_factory, llm=llm, platform=platform, executor=executor,
        notifier=notifier, settings=settings,
        fix_channel=_build_fix_channel(settings, llm),
        perception=_build_perception(settings, session_factory, executor),
    )
    return Scheduler(orchestrator, platform, notifier, session_factory, settings)


def main(argv: list[str] | None = None) -> int:
    """CLI 入口：启动常驻调度器（--once 仅跑一轮用于调试）。"""
    parser = argparse.ArgumentParser(prog="autobugfixer-scheduler",
                                     description="常驻调度器（轮询/出队/回收/SLA）")
    parser.add_argument("--once", action="store_true", help="只跑一轮后退出（调试用）")
    args = parser.parse_args(argv)
    setup_logging()
    scheduler = build_scheduler()
    if args.once:
        print(scheduler.run_round())
        return 0
    scheduler.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
