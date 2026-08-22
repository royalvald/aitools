"""Fernet 凭据加解密往返测试（设计文档 7：凭据不明文落盘）。"""

import pytest

from autobugfixer.common.security.credentials import CredentialVault


def test_encrypt_decrypt_roundtrip():
    vault = CredentialVault(CredentialVault.generate_key())
    plaintext = "ssh-password:p@ssw0rd!中文也支持"
    ciphertext = vault.encrypt(plaintext)
    assert ciphertext != plaintext
    assert plaintext not in ciphertext
    assert vault.decrypt(ciphertext) == plaintext


def test_wrong_key_fails():
    vault_a = CredentialVault(CredentialVault.generate_key())
    vault_b = CredentialVault(CredentialVault.generate_key())
    ciphertext = vault_a.encrypt("secret")
    with pytest.raises(ValueError, match="解密失败"):
        vault_b.decrypt(ciphertext)


def test_default_dev_key_roundtrip():
    """开发兜底派生密钥：同进程两次构造可互解（生产必须配主密钥）。"""
    ciphertext = CredentialVault().encrypt("dev-secret")
    assert CredentialVault().decrypt(ciphertext) == "dev-secret"
