"""知识库导出 CLI：autobugfixer-export --format markdown --out <路径>（FR-SYS-03）。"""

from __future__ import annotations

import argparse
from pathlib import Path

from autobugfixer.common.core.config import Settings, get_settings
from autobugfixer.common.core.db import init_db, make_engine, make_session_factory
from autobugfixer.common.core.logging_setup import setup_logging
from autobugfixer.features.knowledge.export import render_markdown


def main(argv: list[str] | None = None, settings: Settings | None = None) -> int:
    """CLI 入口：导出经验库为 Markdown 文件（导出前脱敏）。"""
    parser = argparse.ArgumentParser(prog="autobugfixer-export",
                                     description="导出经验库为知识文档（导出前脱敏）")
    parser.add_argument("--format", default="markdown", choices=["markdown"])
    parser.add_argument("--out", required=True, help="输出文件路径")
    args = parser.parse_args(argv)
    setup_logging()
    settings = settings or get_settings()

    engine = make_engine(settings.database_url)
    init_db(engine)
    session_factory = make_session_factory(engine)
    with session_factory() as s:
        content = render_markdown(s)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(content, encoding="utf-8")
    print(f"已导出 {len(content)} 字符 -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
