"""测试环境执行器（FR-REG-01，设计文档 6.2）。

LocalExecutor：以本机目录模拟部署环境，供本地开发与 CI；
SSH/Docker/K8s 执行器按环境类型注册接入（首期不实现）。
validate_environment：环境配置预检（Spec 06 §2.1 P1，部署前暴露必败配置）。
"""

from __future__ import annotations

import json
import shlex
import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel

from autobugfixer.adapters.env.whitelist import CommandWhitelist

# 环境类型合法值（Spec 06 §2.1 预检规则 ①：k8s 明确拒绝）
ENV_TYPES = {"local", "ssh", "docker"}


def validate_environment(env, *, global_whitelist: list[str] | None = None,
                         vault=None) -> tuple[list[str], list[str]]:
    """环境配置预检（Spec 06 §2.1 P1）：返回 (errors, warnings)。

    规则：
    ① type 枚举校验（local/ssh/docker；拼错或 k8s 等预留值报错，
      不再静默降级 local）；
    ② ssh 必填 conn_config.host，credential_ref 非空时须可解密为 JSON；
    ③ docker 必填 conn_config.container；
    ④ deploy_script 非空且逐条命中该环境生效的白名单
      （local 用全局配置，ssh/docker 用环境行 cmd_whitelist，与运行期一致）；
    ⑤ local 类型提示 conn_config/cmd_whitelist 字段不生效（警告不报错）。
    """
    errors: list[str] = []
    warnings: list[str] = []
    env_type = (getattr(env, "type", "") or "").strip()
    conn = dict(getattr(env, "conn_config", None) or {})

    if env_type not in ENV_TYPES:
        errors.append(f"type 非法: {env_type!r}（可选 {sorted(ENV_TYPES)}）")
        return errors, warnings

    if env_type == "local":
        if conn:
            warnings.append("local 类型忽略 conn_config（env_root 取全局配置）")
        if getattr(env, "cmd_whitelist", None):
            warnings.append("local 类型忽略环境行 cmd_whitelist（生效的是全局配置）")

    if env_type == "ssh":
        if not (conn.get("host") or "").strip():
            errors.append("ssh 环境缺少 conn_config.host")
        ref = (getattr(env, "credential_ref", "") or "").strip()
        if ref:
            try:
                from autobugfixer.common.security.credentials import CredentialVault

                plain = (vault or CredentialVault()).decrypt(ref)
                if not isinstance(json.loads(plain), dict):
                    raise ValueError("非 JSON 对象")
            except Exception as exc:
                errors.append(f"credential_ref 解密失败: {exc}")

    if env_type == "docker":
        if not (conn.get("container") or "").strip():
            errors.append("docker 环境缺少 conn_config.container")

    script = list(getattr(env, "deploy_script", None) or [])
    if not script:
        errors.append("deploy_script 为空（零条命令的部署无意义）")
    else:
        effective = (list(getattr(env, "cmd_whitelist", None) or [])
                     if env_type in ("ssh", "docker")
                     else list(global_whitelist or []))
        checker = CommandWhitelist(effective)
        for cmd in script:
            if not checker.is_allowed(cmd):
                errors.append(f"部署命令未命中白名单: {cmd}")

    return errors, warnings


class ExecResult(BaseModel):
    """命令执行结果（返回码 + 标准输出/错误）。"""

    cmd: str
    returncode: int
    stdout: str = ""
    stderr: str = ""

    @property
    def ok(self) -> bool:
        """返回码为 0 即成功。"""
        return self.returncode == 0


class Health(BaseModel):
    """环境健康检查结果。"""

    ok: bool
    detail: str = ""


class EnvExecutor(Protocol):
    """统一环境操作接口，白名单校验内建于 exec。"""

    def exec(self, cmd: str) -> ExecResult:
        """执行命令（经白名单校验），返回执行结果。"""
        ...

    def upload(self, local: str | Path, remote_rel: str) -> None:
        """把本地产物上传到环境（部署用）。"""
        ...

    def health_check(self) -> Health:
        """检查环境是否就绪。"""
        ...

    # DSL 运行时能力（验证阶段解释执行用）
    def read_text(self, rel_path: str) -> str | None:
        """读取环境内文件文本（不存在返回 None）。"""
        ...

    def query_db(self, sql: str) -> list[dict]:
        """在环境数据库上执行只读 SQL，返回行列表（DSL 断言用）。"""
        ...


class LocalExecutor:
    """本机目录模拟部署：env_root 下 api/ pages/ logs/ app.db 构成仿真环境。"""

    def __init__(self, env_root: str | Path, whitelist: CommandWhitelist | None = None) -> None:
        self.env_root = Path(env_root)
        self.env_root.mkdir(parents=True, exist_ok=True)
        self.whitelist = whitelist or CommandWhitelist(["echo {text}"])
        self.exec_log: list[ExecResult] = []  # 执行留痕（审计由调用方落库）

    # ---- 文件 ----

    def _resolve(self, rel: str) -> Path:
        target = (self.env_root / rel).resolve()
        if not str(target).startswith(str(self.env_root.resolve())):
            raise ValueError(f"路径越出环境根目录: {rel}")
        return target

    def read_text(self, rel_path: str) -> str | None:
        """读取环境内文件文本；不存在返回 None。"""
        target = self._resolve(rel_path)
        if not target.is_file():
            return None
        return target.read_text(encoding="utf-8")

    def write_text(self, rel_path: str, content: str) -> None:
        """写入环境内文件（自动建父目录）。"""
        target = self._resolve(rel_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def upload(self, local: str | Path, remote_rel: str) -> None:
        """把本地产物（文件或目录）部署到环境目录。"""
        src = Path(local)
        dst = self._resolve(remote_rel)
        if src.is_dir():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

    # ---- 命令（白名单内建） ----

    def exec(self, cmd: str) -> ExecResult:
        """执行命令：先白名单校验（越权拒绝），echo 内建仿真，其余走 subprocess。"""
        self.whitelist.assert_allowed(cmd)  # 越权直接拒绝
        argv = shlex.split(cmd)
        if not argv:
            return ExecResult(cmd=cmd, returncode=1, stderr="空命令")
        if argv[0] == "echo":
            # echo 是 shell 内建，无独立可执行文件；仿真环境用内建实现（不经 shell）
            result = ExecResult(cmd=cmd, returncode=0, stdout=" ".join(argv[1:]))
        else:
            try:
                proc = subprocess.run(
                    argv, cwd=self.env_root, capture_output=True, text=True, timeout=60,
                )
            except FileNotFoundError:
                result = ExecResult(cmd=cmd, returncode=127,
                                    stderr=f"可执行文件不存在: {argv[0]}")
            else:
                result = ExecResult(cmd=cmd, returncode=proc.returncode,
                                    stdout=proc.stdout.strip(), stderr=proc.stderr.strip())
        self.exec_log.append(result)
        return result

    # ---- 健康与回滚 ----

    def health_check(self) -> Health:
        """检查 env_root 是否存在以判定环境就绪。"""
        ok = self.env_root.exists()
        return Health(ok=ok, detail=f"env_root={self.env_root}")

    def snapshot(self, tag: str) -> Path:
        """记录当前版本快照（部署前调用，供回滚）。"""
        snap_dir = self.env_root.parent / f"{self.env_root.name}.snapshots" / tag
        if snap_dir.exists():
            shutil.rmtree(snap_dir)
        snap_dir.mkdir(parents=True, exist_ok=True)
        for item in self.env_root.iterdir():
            if item.is_dir():
                shutil.copytree(item, snap_dir / item.name)
            else:
                shutil.copy2(item, snap_dir)
        return snap_dir

    def restore(self, tag: str) -> None:
        """回滚到指定快照。"""
        snap_dir = self.env_root.parent / f"{self.env_root.name}.snapshots" / tag
        if not snap_dir.exists():
            raise FileNotFoundError(f"快照不存在: {tag}")
        for item in list(self.env_root.iterdir()):
            if item.is_dir():
                shutil.rmtree(item)
            else:
                item.unlink()
        for item in snap_dir.iterdir():
            if item.is_dir():
                shutil.copytree(item, self.env_root / item.name)
            else:
                shutil.copy2(item, self.env_root)

    # ---- DSL 运行时 ----

    def query_db(self, sql: str) -> list[dict]:
        """在仿真环境 app.db 上执行 SQL，返回字典行列表。"""
        db_path = self.env_root / "app.db"
        if not db_path.exists():
            raise FileNotFoundError("仿真环境数据库不存在: app.db")
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        try:
            return [dict(row) for row in conn.execute(sql).fetchall()]
        finally:
            conn.close()


def __getattr__(name: str):
    """远程执行器惰性导出（paramiko / docker SDK 非硬依赖）。"""
    if name == "SSHExecutor":
        from .ssh import SSHExecutor

        return SSHExecutor
    if name == "DockerExecutor":
        from .docker import DockerExecutor

        return DockerExecutor
    raise AttributeError(name)
