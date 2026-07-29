"""CSV 导入 CLI：autobugfixer-import <csv路径> [--platform csv] [--run-analysis]"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .adapters.bug_platform import MockBugPlatform
from .adapters.csv_import import CsvFormatError, parse_csv
from .adapters.env_executor import LocalExecutor
from .adapters.notifier import LogNotifier
from .adapters.whitelist import CommandWhitelist
from .config import Settings, get_settings
from .db import init_db, make_engine, make_session_factory
from .pipeline.orchestrator import Orchestrator
from .services.importer import analyze_tasks, import_bug_rows
from .services.llm_gateway import LLMGateway


def build_parser() -> argparse.ArgumentParser:
    """构造命令行参数解析器（csv 路径 + platform + run-analysis 开关）。"""
    parser = argparse.ArgumentParser(
        prog="autobugfixer-import", description="从 CSV 批量导入 Bug 并可选执行预处理分析")
    parser.add_argument("csv_path", help="CSV 文件路径（支持 utf-8-sig / GBK）")
    parser.add_argument("--platform", default="csv", help="来源平台标识（默认 csv）")
    parser.add_argument("--run-analysis", action="store_true",
                        help="导入后执行预处理分析（完整性/方案/评分，不进入修复）")
    return parser


def main(argv: list[str] | None = None, settings: Settings | None = None) -> int:
    """CLI 入口：解析 CSV、导入任务，可选执行预处理分析。"""
    args = build_parser().parse_args(argv)
    from .logging_setup import setup_logging

    setup_logging()
    settings = settings or get_settings()

    csv_path = Path(args.csv_path)
    if not csv_path.is_file():
        print(f"文件不存在: {csv_path}", file=sys.stderr)
        return 2
    try:
        parsed = parse_csv(csv_path.read_bytes(), platform=args.platform)
    except CsvFormatError as exc:
        print(f"CSV 格式错误: {exc}", file=sys.stderr)
        return 2

    engine = make_engine(settings.database_url)
    init_db(engine)
    session_factory = make_session_factory(engine)

    with session_factory() as session:
        result = import_bug_rows(session, parsed, platform=args.platform,
                                 max_retry=settings.max_retry, source=str(csv_path))
        session.commit()

    print("== 导入结果 ==")
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if args.run_analysis and result["task_ids"]:
        llm = LLMGateway(settings, session_factory)
        orchestrator = Orchestrator(
            session_factory, llm=llm, platform=MockBugPlatform([]),
            executor=LocalExecutor(settings.env_root,
                                   CommandWhitelist(settings.cmd_whitelist)),
            notifier=LogNotifier(), settings=settings,
        )
        summaries = analyze_tasks(orchestrator, session_factory, result["task_ids"])
        print("== 预处理分析结果 ==")
        print(json.dumps(summaries, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
