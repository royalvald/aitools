"""内置适配器注册表（设计文档 6.2："适配器通过配置文件注册，新增零改动核心代码"）。

按名字符串解析缺陷平台与环境执行器；第三方适配器用 ``register_bug_platform`` /
``register_env_executor`` 注册。paramiko / docker SDK 不在本模块导入（保持惰性）。

用法::

    from autobugfixer.adapters.registry import get_bug_platform, get_env_executor

    platform = get_bug_platform("jira", {
        "base_url": "https://xx.atlassian.net",
        "email": "bot@corp.com", "api_token": "...",
        "field_map": {"repro_steps": "customfield_10010"},
    })
    executor = get_env_executor("ssh", {
        "host": "10.0.0.8", "username": "deploy", "key_filename": "~/.ssh/id_rsa",
        "whitelist": ["systemctl restart {service}"], "workdir": "/opt/app",
    })
"""

from __future__ import annotations

from typing import Any, Callable

_BUG_PLATFORMS: dict[str, Callable[..., Any]] = {}
_ENV_EXECUTORS: dict[str, Callable[..., Any]] = {}
_builtins_ready = False


def register_bug_platform(name: str, factory: Callable[..., Any]) -> None:
    """注册缺陷平台适配器工厂（第三方扩展接入点）。"""
    _BUG_PLATFORMS[name] = factory


def register_env_executor(name: str, factory: Callable[..., Any]) -> None:
    """注册环境执行器工厂（第三方扩展接入点）。"""
    _ENV_EXECUTORS[name] = factory


def register_builtin_adapters() -> None:
    """注册内置适配器（幂等）。仅导入适配器类本身，可选依赖仍按需惰性加载。"""
    global _builtins_ready
    from .bug_platform import MockBugPlatform
    from .bug_platform.jira import JiraBugPlatform
    from .bug_platform.zentao import ZentaoBugPlatform
    from .env_executor import LocalExecutor
    from .env_executor.docker_executor import DockerExecutor
    from .env_executor.ssh_executor import SSHExecutor
    from .whitelist import CommandWhitelist

    def _make_local(env_root: str = "./var/testenv", whitelist=None, **kwargs):
        if isinstance(whitelist, list):
            whitelist = CommandWhitelist(whitelist)
        return LocalExecutor(env_root, whitelist)

    register_bug_platform("mock", MockBugPlatform)
    register_bug_platform("jira", JiraBugPlatform)
    register_bug_platform("zentao", ZentaoBugPlatform)
    register_env_executor("local", _make_local)
    register_env_executor("ssh", SSHExecutor)
    register_env_executor("docker", DockerExecutor)
    _builtins_ready = True


def _ensure_builtins() -> None:
    if not _builtins_ready:
        register_builtin_adapters()


def get_bug_platform(name: str, config: dict | None = None, **kwargs):
    """按名字解析缺陷平台适配器。config/ kwargs 原样透传适配器构造参数。"""
    _ensure_builtins()
    try:
        factory = _BUG_PLATFORMS[name]
    except KeyError:
        raise KeyError(
            f"未知缺陷平台适配器: {name!r}（已注册: {sorted(_BUG_PLATFORMS)}）"
        ) from None
    return factory(**{**dict(config or {}), **kwargs})


def get_env_executor(env_type: str, config: dict | None = None, **kwargs):
    """按名字解析环境执行器。config/ kwargs 原样透传适配器构造参数。"""
    _ensure_builtins()
    try:
        factory = _ENV_EXECUTORS[env_type]
    except KeyError:
        raise KeyError(
            f"未知环境执行器: {env_type!r}（已注册: {sorted(_ENV_EXECUTORS)}）"
        ) from None
    return factory(**{**dict(config or {}), **kwargs})


def get_env_executor_for(env, *, vault=None):
    """按 Environment 模型行构建执行器（鸭子类型：type/conn_config/cmd_whitelist/credential_ref）。

    ssh 类型凭据由 ``credential_ref``（Fernet 密文）解密注入；local/docker 走 conn_config。
    """
    env_type = getattr(env, "type", "local")
    if env_type == "ssh":
        from .env_executor.ssh_executor import SSHExecutor

        return SSHExecutor.from_env_model(env, vault=vault)
    if env_type == "docker":
        from .env_executor.docker_executor import DockerExecutor

        return DockerExecutor.from_env_model(env)
    config = dict(getattr(env, "conn_config", None) or {})
    config.setdefault("whitelist", list(getattr(env, "cmd_whitelist", None) or []))
    return get_env_executor(env_type, config)


def registered_adapters() -> dict[str, list[str]]:
    """列出已注册适配器名（自动触发内置注册）。"""
    _ensure_builtins()
    return {
        "bug_platforms": sorted(_BUG_PLATFORMS),
        "env_executors": sorted(_ENV_EXECUTORS),
    }
