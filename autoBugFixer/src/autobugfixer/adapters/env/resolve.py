"""环境执行器解析（11.1 适配器注册）：按任务关联的 Environment 行构建执行器。"""

from __future__ import annotations


def resolve_executor(ctx):
    """按任务关联的 Environment 行解析执行器（11.1 适配器注册）。

    ssh/docker 类型走 registry 构建（凭据由 Vault 解密注入）；
    local 等仿真类型沿用注入的默认执行器，保持现有行为。
    """
    from autobugfixer.common.core.models import Environment
    from autobugfixer.runtime.registry import get_env_executor_for
    from autobugfixer.common.security.credentials import CredentialVault

    if ctx.task.environment_id:
        env = ctx.session.get(Environment, ctx.task.environment_id)
        if env is not None and env.type in ("ssh", "docker"):
            return get_env_executor_for(
                env, vault=CredentialVault(ctx.settings.fernet_key))
    return ctx.executor
