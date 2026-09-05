"""SSH 远程环境执行器（设计文档 4.3.1：FR-REG-01）。

- ``paramiko`` **惰性导入**：仅在连接时 import，缺包抛带安装提示的 RuntimeError，
  不作为项目硬依赖；
- ``exec`` 前强制过命令白名单（CommandWhitelist），模板外命令直接拒绝；
- 主机密钥默认严格校验（known_hosts，P0-5）：加载系统与用户 known_hosts +
  RejectPolicy；仅 ``strict_host_key=False``（实验室环境）回落 AutoAddPolicy；
- SFTP upload/download；``health_check`` 执行配置的健康检查命令（同样过白名单）；
- snapshot/restore（P0-3）：远程发布目录版本化快照（cp -a 全量拷贝至
  ``<workdir>.snapshots/<tag>``），供部署失败真实回滚；
- 凭据由凭据服务解密后注入（``from_env_model`` 从 Environment.credential_ref
  解密 JSON），本模块不打日志、凭据不落盘。
"""

from __future__ import annotations

import json
import logging
import shlex
from pathlib import Path, PurePosixPath

from autobugfixer.adapters.env.whitelist import CommandWhitelist
from autobugfixer.adapters.env import ExecResult, Health

logger = logging.getLogger(__name__)

_INSTALL_HINT = "SSH 执行器需要 paramiko：pip install paramiko（按需安装，非项目硬依赖）"


def _import_paramiko():
    try:
        import paramiko
    except ImportError as exc:
        raise RuntimeError(_INSTALL_HINT) from exc
    return paramiko


class SSHExecutor:
    """SSH 执行器（EnvExecutor 契约 + download）。

    :param host: 主机地址；``port``/``username``/``password``/``key_filename`` 为连接参数。
    :param whitelist: 命令白名单（list[str] 模板或 CommandWhitelist）；默认空名单=拒绝一切。
    :param workdir: 远程工作目录，exec/upload/download/read_text 的相对路径基准。
    :param health_cmd: 健康检查命令（需命中白名单）；不配置则仅检查连通性。
    """

    def __init__(
        self,
        host: str,
        *,
        port: int = 22,
        username: str | None = None,
        password: str | None = None,
        key_filename: str | None = None,
        whitelist: CommandWhitelist | list[str] | None = None,
        workdir: str = "/",
        health_cmd: str | None = None,
        connect_timeout: float = 10.0,
        exec_timeout: float = 60.0,
        strict_host_key: bool = True,
        known_hosts_file: str | None = None,
        sftp_timeout: float = 60.0,
    ) -> None:
        self.host = host
        self.port = port
        self.username = username
        self._password = password  # 仅用于连接，不出现在任何返回值/异常消息中
        self._key_filename = key_filename
        if whitelist is not None and not isinstance(whitelist, CommandWhitelist):
            whitelist = CommandWhitelist(list(whitelist))
        self.whitelist = whitelist or CommandWhitelist([])
        self.workdir = workdir
        self.health_cmd = health_cmd
        self.connect_timeout = connect_timeout
        self.exec_timeout = exec_timeout
        # 主机密钥校验（P0-5）：默认严格 known_hosts + RejectPolicy；
        # strict_host_key=False 回落 AutoAddPolicy（可被 MITM，仅限隔离实验环境）
        self.strict_host_key = strict_host_key
        self.known_hosts_file = known_hosts_file
        self.sftp_timeout = sftp_timeout
        self._client = None  # paramiko.SSHClient，惰性连接

    @classmethod
    def from_env_model(cls, env, *, vault=None, audit=None) -> "SSHExecutor":
        """按 Environment 模型行构建（鸭子类型，不 import models）。

        ``conn_config`` 提供 host/port/workdir/health_cmd 等；``credential_ref``
        为 Fernet 密文，解密后是 JSON：``{"username": ..., "password": ...}`` 或
        ``{"username": ..., "key_filename": ...}``，解密后仅驻留内存用于连接。
        解密动作经 ``audit`` 回调留痕（P0-6：谁在何时解密了哪个环境的凭证）。
        """
        from autobugfixer.common.security.credentials import CredentialVault

        cfg = dict(getattr(env, "conn_config", None) or {})
        ref = getattr(env, "credential_ref", "") or ""
        if ref:
            env_id = getattr(env, "id", "")
            secret = json.loads((vault or CredentialVault()).decrypt(
                ref, label=f"env:{env_id}",
                on_decrypt=(lambda: audit(action="credential_decrypt",
                                          target=f"env:{env_id}")
                            ) if audit is not None else None))
            cfg.update(secret)
        cfg.setdefault(
            "whitelist",
            CommandWhitelist(list(getattr(env, "cmd_whitelist", None) or [])),
        )
        return cls(**cfg)

    # ---- EnvExecutor 契约 ----

    def exec(self, cmd: str) -> ExecResult:
        """白名单校验后在远程主机执行命令（自动 cd 到 workdir）。"""
        self.whitelist.assert_allowed(cmd)  # 越权直接拒绝（连接前）
        full = (
            f"cd {shlex.quote(self.workdir)} && {cmd}"
            if self.workdir and self.workdir != "/"
            else cmd
        )
        _, stdout, stderr = self._connect().exec_command(full, timeout=self.exec_timeout)
        out, err = stdout.read(), stderr.read()
        return ExecResult(
            cmd=cmd,
            returncode=stdout.channel.recv_exit_status(),
            stdout=_decode(out).strip(),
            stderr=_decode(err).strip(),
        )

    def upload(self, local: str | Path, remote_rel: str) -> None:
        """SFTP 上传本地文件/目录到远程（自动建父目录）。"""
        src = Path(local)
        dest = self._remote(remote_rel)
        sftp = self._sftp()
        if src.is_dir():
            self._mkdirs(sftp, dest)
            for item in src.rglob("*"):
                target = f"{dest}/{item.relative_to(src).as_posix()}"
                if item.is_dir():
                    self._mkdirs(sftp, target)
                else:
                    sftp.put(str(item), target)
        else:
            self._mkdirs(sftp, str(PurePosixPath(dest).parent))
            sftp.put(str(src), dest)

    def download(self, remote_rel: str, local: str | Path) -> None:
        """SFTP 下载远程文件/目录到本地。"""
        sftp = self._sftp()
        src = self._remote(remote_rel)
        dst = Path(local)
        if self._is_dir(sftp, src):
            dst.mkdir(parents=True, exist_ok=True)
            for entry in sftp.listdir_attr(src):
                self.download(f"{PurePosixPath(remote_rel) / entry.filename}", dst / entry.filename)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            sftp.get(src, str(dst))

    def health_check(self) -> Health:
        """执行配置的健康检查命令，未配置则仅检查 SSH 连通性。"""
        if self.health_cmd:
            result = self.exec(self.health_cmd)
            return Health(ok=result.ok, detail=result.stdout or result.stderr)
        try:
            self._connect()
            return Health(ok=True, detail=f"ssh://{self.host}:{self.port}")
        except RuntimeError:
            raise  # 缺依赖等安装提示不吞掉
        except Exception as exc:  # 连接失败不算系统错误，返回不健康即可
            return Health(ok=False, detail=f"{type(exc).__name__}: {exc}")

    def read_text(self, rel_path: str) -> str | None:
        """读取远程文件文本；IO 异常返回 None。"""
        sftp = self._sftp()
        try:
            with sftp.open(self._remote(rel_path), "r") as f:
                return _decode(f.read())
        except (IOError, OSError):
            return None

    def query_db(self, sql: str) -> list[dict]:
        """SSH 执行器不内建 DB 通道，固定抛 NotImplementedError。"""
        raise NotImplementedError(
            "SSH 执行器不内建数据库通道：请用 exec + 白名单 SQL 客户端命令，"
            "或为该环境配置支持 query_db 的执行器（如 LocalExecutor）"
        )

    # ---- 连接管理 ----

    def _connect(self):
        if self._client is not None and not self._transport_alive():
            # 断线重连（P0-5）：旧连接的 transport 已死，丢弃重建
            logger.warning("SSH 连接已断开，尝试重连 %s:%s", self.host, self.port)
            self.close()
        if self._client is None:
            paramiko = _import_paramiko()
            client = paramiko.SSHClient()
            if self.strict_host_key:
                # 严格校验（P0-5）：系统 + 用户 known_hosts 全量加载，未知主机直接拒绝
                client.load_system_host_keys()
                hosts_file = self.known_hosts_file or str(
                    Path.home() / ".ssh" / "known_hosts")
                try:
                    client.load_host_keys(hosts_file)
                except OSError as exc:
                    raise PermissionError(
                        f"SSH 主机密钥严格校验失败（无法读取 known_hosts: {hosts_file}: "
                        f"{exc}）。先手工 ssh 连接一次收录主机密钥，或在隔离实验环境"
                        "显式配置 strict_host_key=False") from exc
                client.set_missing_host_key_policy(paramiko.RejectPolicy())
            else:
                logger.warning(
                    "SSH strict_host_key=False：AutoAddPolicy 自动信任未知主机密钥，"
                    "存在 MITM 风险，仅限隔离实验环境使用")
                client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(
                self.host,
                port=self.port,
                username=self.username,
                password=self._password,
                key_filename=self._key_filename,
                timeout=self.connect_timeout,
            )
            self._client = client
        return self._client

    def _transport_alive(self) -> bool:
        """判断现有连接是否仍然可用（transport 存活且未关闭）。"""
        try:
            transport = self._client.get_transport()
            return bool(transport and transport.is_active())
        except Exception:
            return False

    def _sftp(self):
        sftp = self._connect().open_sftp()
        channel = getattr(sftp, "get_channel", None)
        if channel is not None:  # SFTP 超时（P0-5）：防远端僵死挂住调用方
            try:
                channel().settimeout(self.sftp_timeout)
            except Exception:
                pass
        return sftp

    # ---- 远程快照/恢复（P0-3：发布目录版本化） ----

    def _snap_root(self) -> str:
        return f"{self.workdir.rstrip('/')}.snapshots"

    def _run_internal(self, cmd: str) -> None:
        """系统内部命令（快照/恢复），不经白名单（非模型/平台可控输入）。"""
        _, stdout, stderr = self._connect().exec_command(cmd, timeout=self.exec_timeout)
        code = stdout.channel.recv_exit_status()
        if code != 0:
            raise RuntimeError(f"远程命令失败({code}): {_decode(stderr.read())[:200]}")

    def snapshot(self, tag: str) -> str:
        """远程快照：``cp -a`` 全量拷贝 workdir 至 ``<workdir>.snapshots/<tag>``。"""
        if self.workdir in ("", "/"):
            raise ValueError(f"非法快照目标 workdir: {self.workdir!r}")
        root, snap = shlex.quote(f"{self._snap_root()}/{tag}"), shlex.quote(self.workdir)
        self._run_internal(f"rm -rf {root} && mkdir -p {root} && cp -a {snap}/. {root}/")
        return f"{self._snap_root()}/{tag}"

    def restore(self, tag: str) -> None:
        """远程恢复：清空 workdir 后从快照拷回（回滚是覆盖语义，非合并）。"""
        if self.workdir in ("", "/"):
            raise ValueError(f"非法恢复目标 workdir: {self.workdir!r}")
        root, snap = shlex.quote(f"{self._snap_root()}/{tag}"), shlex.quote(self.workdir)
        # 先确认快照存在，避免 rm -rf 后才发现无快照可恢复
        self._run_internal(f"test -d {root}")
        self._run_internal(f"find {snap} -mindepth 1 -maxdepth 1 -exec rm -rf {{}} + "
                          f"&& cp -a {root}/. {snap}/")

    def close(self) -> None:
        """关闭 SSH 连接并清空引用。"""
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "SSHExecutor":
        """支持 with 语句。"""
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---- 内部 ----

    def _remote(self, rel: str) -> str:
        path = PurePosixPath(rel)
        if path.is_absolute():
            return str(path)
        return str(PurePosixPath(self.workdir) / path)

    @staticmethod
    def _mkdirs(sftp, path: str) -> None:
        parts = PurePosixPath(path).parts
        current = "/" if PurePosixPath(path).is_absolute() else ""
        for part in parts:
            if part == "/":
                continue
            current = f"{current}/{part}" if current else part
            try:
                sftp.mkdir(current)
            except IOError:
                pass  # 已存在

    @staticmethod
    def _is_dir(sftp, path: str) -> bool:
        import stat

        try:
            return stat.S_ISDIR(sftp.stat(path).st_mode)
        except IOError:
            return False


def _decode(data) -> str:
    if isinstance(data, bytes):
        return data.decode(errors="replace")
    return str(data)
