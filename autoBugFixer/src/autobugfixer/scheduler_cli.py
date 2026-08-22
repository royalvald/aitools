"""调度器 CLI：autobugfixer-scheduler（常驻：轮询拉新/出队调度/超时回收/SLA 升级）。"""

from __future__ import annotations

import argparse
import sys

from autobugfixer.fixing.codex import CodexPreflightError, CodexCLI, codex_preflight
from autobugfixer.intervention.notifier_im import build_notifier
from autobugfixer.runtime.registry import get_bug_platform
from autobugfixer.env import LocalExecutor
from autobugfixer.env.whitelist import CommandWhitelist
from .api.app import _build_perception
from autobugfixer.core.config import Settings, get_settings
from autobugfixer.core.db import init_db, make_engine, make_session_factory
from autobugfixer.core.logging_setup import setup_logging
from autobugfixer.runtime.orchestrator import Orchestrator
from autobugfixer.core.llm import LLMGateway, LLMPreflightError
from autobugfixer.runtime.scheduler import Scheduler


def build_scheduler(settings: Settings | None = None, *, codex=None) -> Scheduler:
    """组装调度器（测试可直接驱动 run_round，不跑死循环）。

    codex：测试可注入 ScriptedCodexCLI 桩；缺省按配置构建真实 CodexCLI。
    """
    settings = settings or get_settings()
    engine = make_engine(settings.database_url)
    init_db(engine)
    session_factory = make_session_factory(engine)
    llm = LLMGateway(settings, session_factory)
    report = llm.preflight()  # LLM 预检（Spec 02 B0）：调度器依赖 LLM，配置错拒绝启动
    if not report.ok:
        raise LLMPreflightError(f"LLM 预检失败: {report.summary()}")
    # codex 预检（Spec 05 §2.2）：调度器会派发修复任务，通道不可用拒绝启动
    codex_errors = codex_preflight(settings)
    if codex_errors:
        raise CodexPreflightError(f"codex 预检失败: {'; '.join(codex_errors)}")
    executor = LocalExecutor(settings.env_root, CommandWhitelist(settings.cmd_whitelist))
    notifier = build_notifier(settings)
    platform = get_bug_platform(settings.bug_platform, settings.bug_platform_config)
    orchestrator = Orchestrator(
        session_factory, llm=llm, platform=platform, executor=executor,
        notifier=notifier, settings=settings,
        codex=codex if codex is not None else CodexCLI.from_settings(settings),
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
    try:
        scheduler = build_scheduler()
    except (LLMPreflightError, CodexPreflightError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if args.once:
        print(scheduler.run_round())
        return 0
    scheduler.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
