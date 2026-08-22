"""命令白名单校验测试（FR-REG-01）：放行/拒绝。"""

import pytest

from autobugfixer.adapters.env.whitelist import CommandRejectedError, CommandWhitelist


@pytest.fixture()
def whitelist() -> CommandWhitelist:
    return CommandWhitelist([
        "echo {text}",
        "systemctl restart {service}",
        "tail -n {n} {log}",
    ])


@pytest.mark.parametrize("cmd", [
    "echo hello",
    "echo deploying-v1.2.0",
    "systemctl restart my-svc",
    "tail -n 100 /var/log/app.log",
])
def test_allowed_commands(whitelist, cmd):
    assert whitelist.is_allowed(cmd)
    whitelist.assert_allowed(cmd)


@pytest.mark.parametrize("cmd", [
    "rm -rf /",
    "cat /etc/passwd",
    "echo ok; rm -rf /",              # 拼接注入
    "echo ok && reboot",
    "echo $(whoami)",                  # 命令替换
    "echo `id`",
    "echo a | sh",
    "systemctl restart nginx; reboot",
    "systemctl stop my-svc",           # 模板未声明 stop
    "tail -n 100 /var/log/app.log > /tmp/x",
    "",
])
def test_rejected_commands(whitelist, cmd):
    assert not whitelist.is_allowed(cmd)
    with pytest.raises(CommandRejectedError):
        whitelist.assert_allowed(cmd)
