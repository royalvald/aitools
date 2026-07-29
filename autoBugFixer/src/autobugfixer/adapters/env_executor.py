"""测试环境执行器（FR-REG-01，设计文档 6.2）。

LocalExecutor：以本机目录模拟部署环境，供本地开发与 CI；
SSH/Docker/K8s 执行器按环境类型注册接入（首期不实现）。
"""

from __future__ import annotations

import shlex
import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel

from .whitelist import CommandWhitelist


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
