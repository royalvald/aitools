"""凭据加密（设计文档 7：Fernet 对称加密 + 主密钥来自环境变量/KMS）。

凭据不明文落盘：environment.credential_ref 存 Fernet 密文，运行时解密注入。

P0-5 整改：
- 兜底派生密钥（开发用）回落时显式告警，不再静默；
- ``credential_preflight``：生产模式（production_mode=True）下未配置主密钥
  直接报错，启动点复用 LLM preflight 机制拒绝启动；
- ``decrypt`` 支持审计回调：谁在何时解密了哪个环境的凭证（P0-6）。
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)


class CredentialVault:
    """Fernet 加解密器。主密钥优先取显式传入，其次环境变量，最后兜底派生（仅开发用）。"""

    def __init__(self, key: str | bytes | None = None) -> None:
        if key is None:
            key = os.environ.get("AUTOBUGFIXER_FERNET_KEY")
        if key is None:
            # 开发兜底：从机器无关常量派生，仅保证"不明文"，生产必须配置主密钥
            logger.warning(
                "FERNET_KEY 未配置，回落开发派生密钥（autobugfixer-dev-key）——"
                "密文可被任何持有源码的人解密，禁止用于生产。"
                "设置 AUTOBUGFIXER_FERNET_KEY 或 FERNET_KEY 环境变量。")
            key = base64.urlsafe_b64encode(hashlib.sha256(b"autobugfixer-dev-key").digest())
        if isinstance(key, str):
            key = key.encode()
        self._fernet = Fernet(key)

    @staticmethod
    def generate_key() -> str:
        """生成一个新的 Fernet 主密钥（base64 字符串）。"""
        return Fernet.generate_key().decode()

    def encrypt(self, plaintext: str) -> str:
        """加密明文为 Fernet 密文字符串。"""
        return self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt(self, ciphertext: str, *, on_decrypt=None, label: str = "") -> str:
        """解密 Fernet 密文；主密钥不匹配或密文损坏抛 ValueError。

        :param on_decrypt: 解密成功后的审计回调 ``on_decrypt()``（P0-6：解密
            动作留痕「谁在何时解密了哪个环境的凭证」；不传则仅记应用日志）。
        :param label: 审计/日志里标识凭证归属（如 ``env:3``、``platform:jira``）。
        """
        plain = self._decrypt_raw(ciphertext)
        logger.info("凭证解密: %s", label or "unlabeled")
        if on_decrypt is not None:
            try:
                on_decrypt()
            except Exception:  # 审计失败不阻断解密主链路，但必须留告警
                logger.exception("凭证解密审计写入失败: %s", label)
        return plain

    def _decrypt_raw(self, ciphertext: str) -> str:
        try:
            return self._fernet.decrypt(ciphertext.encode()).decode()
        except InvalidToken as exc:
            raise ValueError("凭据解密失败：主密钥不匹配或密文损坏") from exc


def credential_preflight(settings) -> list[str]:
    """凭证安全预检（P0-5）：返回错误列表（空 = 通过）。

    生产模式（production_mode=True）下未配置 FERNET_KEY 拒绝启动；
    非生产模式恒通过（开发回落仅告警，见 CredentialVault）。
    """
    if settings.production_mode and not (
            settings.fernet_key or os.environ.get("FERNET_KEY")
            or os.environ.get("AUTOBUGFIXER_FERNET_KEY")):
        return ["生产模式未配置凭据主密钥：设置 AUTOBUGFIXER_FERNET_KEY"
                "（可用 CredentialVault.generate_key() 生成）"]
    return []
