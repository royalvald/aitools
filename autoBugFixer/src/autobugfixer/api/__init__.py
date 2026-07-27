"""对内 API（设计文档 6.1）：任务看板、介入处理、webhook 接入、指标、经验检索。"""

from .app import create_app

__all__ = ["create_app"]
