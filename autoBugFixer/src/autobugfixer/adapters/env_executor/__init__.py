"""测试环境执行器包。

兼容说明：仓库历史为扁平模块 ``adapters/env_executor.py``（Protocol + LocalExecutor）。
新增同名子包后，Python 包优先于同名模块被解析；本 ``__init__`` 通过文件加载
透传原模块的全部公共契约（ExecResult / Health / EnvExecutor / LocalExecutor），
既有 ``from autobugfixer.adapters.env_executor import ...`` 调用不受影响。

真实远程实现见同包 ``ssh_executor.py`` / ``docker_executor.py``
（paramiko / docker SDK 均为函数内惰性导入，非项目硬依赖）。
"""

from __future__ import annotations

import importlib.util as _ilu
from pathlib import Path as _Path

_spec = _ilu.spec_from_file_location(
    "autobugfixer.adapters._legacy_env_executor",
    _Path(__file__).resolve().parent.parent / "env_executor.py",
)
_legacy = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_legacy)

for _name in dir(_legacy):
    if not _name.startswith("_"):
        globals()[_name] = getattr(_legacy, _name)


def __getattr__(name: str):
    """远程执行器惰性导出。"""
    if name == "SSHExecutor":
        from .ssh_executor import SSHExecutor

        return SSHExecutor
    if name == "DockerExecutor":
        from .docker_executor import DockerExecutor

        return DockerExecutor
    raise AttributeError(name)
