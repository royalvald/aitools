"""凭据加密（设计文档 7：Fernet 对称加密 + 主密钥来自环境变量/KMS）。

凭据不明文落盘：environment.credential_ref 存 Fernet 密文，运行时解密注入。
"""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken


class CredentialVault:
    """Fernet 加解密器。主密钥优先取显式传入，其次环境变量，最后兜底派生（仅开发用）。"""

    def __init__(self, key: str | bytes | None = None) -> None:
        if key is None:
            key = os.environ.get("AUTOBUGFIXER_FERNET_KEY")
        if key is None:
            # 开发兜底：从机器无关常量派生，仅保证"不明文"，生产必须配置主密钥
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

    def decrypt(self, ciphertext: str) -> str:
        """解密 Fernet 密文；主密钥不匹配或密文损坏抛 ValueError。"""
        try:
            return self._fernet.decrypt(ciphertext.encode()).decode()
        except InvalidToken as exc:
            raise ValueError("凭据解密失败：主密钥不匹配或密文损坏") from exc
