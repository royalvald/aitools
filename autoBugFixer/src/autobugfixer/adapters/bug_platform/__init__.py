"""缺陷平台适配器包。

兼容说明：仓库历史为扁平模块 ``adapters/bug_platform.py``（Protocol + Mock）。
新增同名子包后，Python 包优先于同名模块被解析；本 ``__init__`` 通过文件加载
透传原模块的全部公共契约（BugTicketData / BugPatch / BugPlatformAdapter /
MockBugPlatform / sample_bugs），既有 ``from autobugfixer.adapters.bug_platform import ...``
调用不受影响，原模块保持唯一事实来源（不复制代码）。

真实平台实现见同包 ``jira.py`` / ``zentao.py``（惰性导出，避免无谓依赖加载）。
"""

from __future__ import annotations

import importlib.util as _ilu
from pathlib import Path as _Path

# 以私有模块名加载被遮蔽的 legacy 模块，全项目共享同一份类定义（isinstance 安全）
_spec = _ilu.spec_from_file_location(
    "autobugfixer.adapters._legacy_bug_platform",
    _Path(__file__).resolve().parent.parent / "bug_platform.py",
)
_legacy = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_legacy)

for _name in dir(_legacy):
    if not _name.startswith("_"):
        globals()[_name] = getattr(_legacy, _name)


def __getattr__(name: str):
    """真实平台适配器惰性导出。"""
    if name == "JiraBugPlatform":
        from .jira import JiraBugPlatform

        return JiraBugPlatform
    if name == "ZentaoBugPlatform":
        from .zentao import ZentaoBugPlatform

        return ZentaoBugPlatform
    raise AttributeError(name)
