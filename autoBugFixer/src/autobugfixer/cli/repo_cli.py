"""仓库登记 CLI（Spec 01 §10）：autobugfixer-repo register/list/refresh。

仓库信息独立于 Bug 登记（全局共享资产）：登记时本地可用性校验 + 可选 LLM
画像（--profile 或首次被 Bug 引用时补齐）；画像一次生成全局复用，refresh
手动刷新。Bug 声明仓库时自动解析到登记表（未登记可按配置自动登记）。
"""

from __future__ import annotations

import argparse
import sys

from autobugfixer.common.core.config import Settings, get_settings
from autobugfixer.common.core.db import init_db, make_engine, make_session_factory
from autobugfixer.common.core.llm import LLMGateway
from autobugfixer.features.ingest.repo_check import list_repos, register_repo


def build_parser() -> argparse.ArgumentParser:
    """构造命令行参数解析器（register/list/refresh 子命令）。"""
    parser = argparse.ArgumentParser(
        prog="autobugfixer-repo", description="全局仓库登记表维护（独立于 Bug）")
    sub = parser.add_subparsers(dest="command", required=True)

    p_reg = sub.add_parser("register", help="登记仓库（本地路径 + 分支，可多个）")
    p_reg.add_argument("paths", nargs="+", help="仓库本地目录路径")
    p_reg.add_argument("--branch", default="main", help="分支（默认 main）")
    p_reg.add_argument("--profile", action="store_true",
                       help="登记后立即 LLM 画像（默认延后到首次被 Bug 引用）")

    sub.add_parser("list", help="列出登记表（含可用性与画像状态）")

    p_ref = sub.add_parser("refresh", help="刷新（复检可用性；--profile 重画像）")
    p_ref.add_argument("repo_id", nargs="?", type=int, help="登记表条目 id（缺省全部）")
    p_ref.add_argument("--profile", action="store_true", help="同时重新 LLM 画像")
    return parser


def _print_repos(repos) -> None:
    for r in repos:
        profiled = "已画像" if r.profile else "未画像"
        print(f"[{r.id}] {r.path} @ {r.branch} — {r.status}"
              + (f"（{r.fail_reason}）" if r.fail_reason else "")
              + f" | {profiled} | 来源 {r.source}")


def main(argv: list[str] | None = None, settings: Settings | None = None) -> int:
    """CLI 入口：登记表维护（register/list/refresh）。"""
    args = build_parser().parse_args(argv)
    from autobugfixer.common.core.logging_setup import setup_logging

    setup_logging()
    settings = settings or get_settings()
    engine = make_engine(settings.database_url)
    init_db(engine)
    session_factory = make_session_factory(engine)

    need_llm = args.command == "register" and args.profile or (
        args.command == "refresh" and args.profile)
    if need_llm:  # LLM 预检（口径同 import CLI）：配置错启动即拦
        report = LLMGateway(settings).preflight()
        if not report.ok:
            print(f"LLM 预检失败: {report.summary()}", file=sys.stderr)
            return 2

    with session_factory() as session:
        if args.command == "register":
            from autobugfixer.features.completeness.repo_profile import profile_repo

            llm = LLMGateway(settings, session_factory) if args.profile else None
            for path in args.paths:
                repo = register_repo(session, path, args.branch, source="manual")
                mark = "新登记" if repo.source == "manual" else "已登记(复检)"
                print(f"{mark}: {repo.path} @ {repo.branch} -> {repo.status}"
                      + (f"（{repo.fail_reason}）" if repo.fail_reason else ""))
                if args.profile and repo.status == "available":
                    profile_repo(llm, session, repo)
                    print(f"  画像完成: {(repo.profile or {}).get('summary', '')}")
            session.commit()
            return 0

        if args.command == "list":
            _print_repos(list_repos(session))
            return 0

        # refresh：复检可用性（+ 可选重画像）
        from autobugfixer.common.core.models import Repo

        repos = ([session.get(Repo, args.repo_id)] if args.repo_id
                 else list_repos(session))
        repos = [r for r in repos if r is not None]
        if not repos:
            print("登记表为空或条目不存在", file=sys.stderr)
            return 2
        from autobugfixer.features.completeness.repo_profile import refresh_profile

        llm = LLMGateway(settings, session_factory) if args.profile else None
        for repo in repos:
            register_repo(session, repo.path, repo.branch,
                          source=repo.source, recheck=True)
            if args.profile and repo.status == "available":
                refresh_profile(llm, session, repo)
                print(f"已重画像 [{repo.id}] {repo.path}")
            else:
                print(f"已复检 [{repo.id}] {repo.path} @ {repo.branch} -> {repo.status}")
        session.commit()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
