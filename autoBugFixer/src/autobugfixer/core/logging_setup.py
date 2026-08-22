"""日志配置：强制 UTF-8 输出，修复 Windows 控制台中文乱码（仅影响显示，不影响落库）。"""

from __future__ import annotations

import logging
import sys


def setup_logging(level: int = logging.INFO) -> None:
    """入口（CLI/API）调用一次：stdout/stderr 重配 UTF-8 + basicConfig。"""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:  # 某些流（如重定向句柄）不支持，忽略
                pass
    # Windows 下重新创建 handler，确保拿到重配后的流
    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root.addHandler(handler)
    root.setLevel(level)
