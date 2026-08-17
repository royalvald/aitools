"""Docker 容器环境执行器（设计文档 4.3.1：FR-REG-01）。

- ``docker`` SDK **惰性导入**：仅在连接时 import，缺包抛带安装提示的 RuntimeError，
  不作为项目硬依赖；
- ``exec`` 前强制过命令白名单（CommandWhitelist），容器内以 ``sh -c`` 执行
  （白名单已拒绝 shell 元字符，不会引入注入面）；
- 文件拷入拷出走 tar 归档（``put_archive`` / ``get_archive``）；
- ``health_check`` 检查容器 running，可附加配置的健康检查命令（同样过白名单）。
"""

from __future__ import annotations

import io
import tarfile
from pathlib import Path, PurePosixPath

from ..whitelist import CommandWhitelist
from . import ExecResult, Health

_INSTALL_HINT = "Docker 执行器需要 docker SDK：pip install docker（按需安装，非项目硬依赖）"


def _import_docker():
    try:
        import docker
    except ImportError as exc:
        raise RuntimeError(_INSTALL_HINT) from exc
    return docker


class DockerExecutor:
    """Docker 执行器（EnvExecutor 契约 + download）。

    :param container: 容器名或 id。
    :param whitelist: 命令白名单（list[str] 模板或 CommandWhitelist）；默认空名单=拒绝一切。
    :param workdir: 容器内工作目录，exec/upload/download/read_text 的相对路径基准。
    :param health_cmd: 健康检查命令（需命中白名单）；不配置则仅检查容器状态。
    :param base_url: Docker daemon 地址（默认读环境，同 docker.from_env）。
    :param client: 可注入 docker.DockerClient（测试用 fake）。
    """

    def __init__(
        self,
        container: str,
        *,
        whitelist: CommandWhitelist | list[str] | None = None,
        workdir: str = "/",
        health_cmd: str | None = None,
        base_url: str | None = None,
        client=None,
        exec_timeout: float = 60.0,
    ) -> None:
        self.container_name = container
        if whitelist is not None and not isinstance(whitelist, CommandWhitelist):
            whitelist = CommandWhitelist(list(whitelist))
        self.whitelist = whitelist or CommandWhitelist([])
        self.workdir = workdir
        self.health_cmd = health_cmd
        self.base_url = base_url
        self._client = client
        self.exec_timeout = exec_timeout

    @classmethod
    def from_env_model(cls, env) -> "DockerExecutor":
        """按 Environment 模型行构建（鸭子类型，不 import models）。

        ``conn_config`` 提供 container/workdir/health_cmd/base_url。
        """
        cfg = dict(getattr(env, "conn_config", None) or {})
        cfg.setdefault(
            "whitelist",
            CommandWhitelist(list(getattr(env, "cmd_whitelist", None) or [])),
        )
        return cls(**cfg)

    # ---- EnvExecutor 契约 ----

    def exec(self, cmd: str) -> ExecResult:
        """白名单校验后在容器内以 sh -c 执行命令（exec_timeout 超时生效）。

        docker SDK 的 exec_run 不接受超时参数，此处用线程包装等待：
        超时后放弃等待（不 join 挂死线程）并按 124（超时约定退出码）返回。
        """
        from concurrent.futures import ThreadPoolExecutor
        from concurrent.futures import TimeoutError as FuturesTimeoutError

        self.whitelist.assert_allowed(cmd)  # 越权直接拒绝
        pool = ThreadPoolExecutor(max_workers=1)
        try:
            future = pool.submit(self._container().exec_run,
                                 ["/bin/sh", "-c", cmd], workdir=self.workdir, demux=True)
            try:
                returncode, output = future.result(timeout=self.exec_timeout)
            except FuturesTimeoutError:
                return ExecResult(cmd=cmd, returncode=124,
                                  stderr=f"容器命令超时（{self.exec_timeout}s）: {cmd}")
        finally:
            pool.shutdown(wait=False, cancel_futures=True)  # 不等挂死线程
        out, err = output if isinstance(output, tuple) else (output, b"")
        return ExecResult(
            cmd=cmd, returncode=returncode, stdout=_decode(out).strip(), stderr=_decode(err).strip()
        )

    def upload(self, local: str | Path, remote_rel: str) -> None:
        """把本地文件/目录打包为 tar 拷入容器。"""
        src = Path(local)
        dest = self._remote(remote_rel)
        if src.is_dir():
            self._container().put_archive(dest, _make_tar(src, src.name))
        else:
            parent = str(PurePosixPath(dest).parent)
            self._container().put_archive(parent, _make_tar(src, src.name))

    def download(self, remote_rel: str, local: str | Path) -> None:
        """从容器拉取文件/目录到本地（解 tar 归档）。"""
        data = self._fetch_archive(self._remote(remote_rel))
        dst = Path(local)
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            members = [m for m in tar.getmembers() if m.isfile()]
            if dst.suffix and len(members) == 1:
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(tar.extractfile(members[0]).read())
            else:
                dst.mkdir(parents=True, exist_ok=True)
                for m in members:
                    target = dst / m.name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(tar.extractfile(m).read())

    def health_check(self) -> Health:
        """检查容器 running 状态，可选执行配置的健康检查命令。"""
        try:
            container = self._container()
            container.reload()
            status = getattr(container, "status", "unknown")
            if status != "running":
                return Health(ok=False, detail=f"container {self.container_name} status={status}")
            if self.health_cmd:
                result = self.exec(self.health_cmd)
                return Health(ok=result.ok, detail=result.stdout or result.stderr)
            return Health(ok=True, detail=f"container {self.container_name} running")
        except RuntimeError:
            raise  # 缺依赖等安装提示不吞掉
        except Exception as exc:
            return Health(ok=False, detail=f"{type(exc).__name__}: {exc}")

    def read_text(self, rel_path: str) -> str | None:
        """读取容器内文件文本；不可读或不存在返回 None。"""
        try:
            data = self._fetch_archive(self._remote(rel_path))
            with tarfile.open(fileobj=io.BytesIO(data)) as tar:
                member = next((m for m in tar.getmembers() if m.isfile()), None)
                if member is None:
                    return None
                extracted = tar.extractfile(member)
                return extracted.read().decode() if extracted else None
        except Exception:
            return None  # 远端无此文件或归档失败均视为不可读

    def query_db(self, sql: str) -> list[dict]:
        """Docker 执行器不内建 DB 通道，固定抛 NotImplementedError。"""
        raise NotImplementedError(
            "Docker 执行器不内建数据库通道：请用 exec + 白名单 SQL 客户端命令，"
            "或为该环境配置支持 query_db 的执行器（如 LocalExecutor）"
        )

    def close(self) -> None:
        """关闭底层 docker client。"""
        if self._client is not None:
            self._client.close()

    def __enter__(self) -> "DockerExecutor":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---- 内部 ----

    def _client_or_create(self):
        if self._client is None:
            docker = _import_docker()
            self._client = (
                docker.DockerClient(base_url=self.base_url)
                if self.base_url
                else docker.from_env()
            )
        return self._client

    def _container(self):
        return self._client_or_create().containers.get(self.container_name)

    def _remote(self, rel: str) -> str:
        path = PurePosixPath(rel)
        if path.is_absolute():
            return str(path)
        return str(PurePosixPath(self.workdir) / path)

    def _fetch_archive(self, remote_path: str) -> bytes:
        stream, _stat = self._container().get_archive(remote_path)
        return b"".join(stream)


def _make_tar(src: Path, arcname: str) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        tar.add(src, arcname=arcname)
    return buf.getvalue()


def _decode(data) -> str:
    if isinstance(data, bytes):
        return data.decode(errors="replace")
    return str(data or "")
