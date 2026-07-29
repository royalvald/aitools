"""感知服务：三维快照采集、落库留痕与修复前后对比（FR-FIX-02）。

按验证方案（VerificationPlan.steps 的 DSL 步骤）自动拆解三类观测点：
- 页面：open_page / click / input / assert_element
- 数据库：query_db / assert_db
- 接口：call_api / assert_response

三个维度可独立开关（构造时不注入对应适配器，或 capture 时传 enable_xxx=False）。
快照落库到本模块自有表 perception_snapshot（不改 models.py 现有表），
原始证据（截屏/HTML/快照 JSON）写磁盘。
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import JSON, DateTime, Integer, String
from sqlalchemy.orm import Mapped, Session, mapped_column, sessionmaker

from autobugfixer.db import Base
from autobugfixer.models import Task, VerificationPlan
from autobugfixer.pipeline.dsl import DSLStep

from .api_layer import API_ACTIONS, APIPerception
from .base import (
    ObservationContext,
    PerceptionAdapter,
    PerceptionException,
    PerceptionPhase,
    PerceptionSnapshot,
)
from .db_layer import DB_ACTIONS, DBPerception
from .page import PAGE_ACTIONS, PagePerception

_ACTION_TO_DIM: dict[str, str] = {
    **{a: "page" for a in PAGE_ACTIONS},
    **{a: "db" for a in DB_ACTIONS},
    **{a: "api" for a in API_ACTIONS},
}


class PerceptionSnapshotRecord(Base):
    """感知快照留痕表（本模块自有，不改动 models.py 现有表）。

    接入时需让该表随建表注册：在 db.init_db 前 import 本模块，
    或直接调用 init_perception_db(engine)（checkfirst，可重复调用）。
    """

    __tablename__ = "perception_snapshot"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(Integer, index=True)
    phase: Mapped[str] = mapped_column(String(20), index=True)  # pre_fix / post_fix
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)  # PerceptionSnapshot 序列化
    evidence_uris: Mapped[list] = mapped_column(JSON, default=list)
    exception_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


def init_perception_db(engine) -> None:
    """注册并创建感知快照表（Base.metadata 共享，checkfirst 幂等）。"""
    Base.metadata.create_all(engine)


class SnapshotDiff:
    """pre/post 快照差异摘要。"""

    def __init__(
        self,
        resolved: list[PerceptionException],
        persistent: list[PerceptionException],
        introduced: list[PerceptionException],
    ) -> None:
        self.resolved = resolved  # 已消除：pre 有、post 无
        self.persistent = persistent  # 仍存在：两侧都有
        self.introduced = introduced  # 新增：post 有、pre 无

    @property
    def fixed(self) -> bool:
        """无残留且无副作用：仍存在与新增均为空。"""
        return not self.persistent and not self.introduced

    @property
    def summary(self) -> str:
        """生成可读的差异摘要文本（统计 + 逐条列出三类异常）。"""
        lines = [
            f"已消除 {len(self.resolved)} 项 / 仍存在 {len(self.persistent)} 项 / 新增 {len(self.introduced)} 项"
        ]
        for label, items in (("已消除", self.resolved), ("仍存在", self.persistent),
                             ("新增", self.introduced)):
            for exc in items:
                lines.append(f"[{label}] {exc.dimension}/{exc.kind}: {exc.key} {exc.detail}".rstrip())
        return "\n".join(lines)

    def to_dict(self) -> dict:
        """序列化为字典（含三类异常、是否修复、摘要文本）。"""
        return {
            "resolved": [e.model_dump() for e in self.resolved],
            "persistent": [e.model_dump() for e in self.persistent],
            "introduced": [e.model_dump() for e in self.introduced],
            "fixed": self.fixed,
            "summary": self.summary,
        }


def _exc_key(exc: PerceptionException) -> tuple[str, str, str]:
    return (exc.dimension, exc.kind, exc.key)


class PerceptionService:
    """三维感知编排：capture 采快照，compare 出差异摘要。"""

    def __init__(
        self,
        session_factory: sessionmaker[Session] | None = None,
        evidence_root: str | Path = "evidence",
        page: PagePerception | None = None,
        db: DBPerception | None = None,
        api: APIPerception | None = None,
    ) -> None:
        self.session_factory = session_factory  # None 则只采集不落库
        self.evidence_root = Path(evidence_root)
        # 维度开关：适配器为 None 即关闭该维度
        self.adapters: dict[str, PerceptionAdapter] = {
            k: v for k, v in {"page": page, "db": db, "api": api}.items() if v is not None
        }

    def capture(
        self,
        task: Task,
        plan: VerificationPlan,
        phase: PerceptionPhase,
        *,
        enable_page: bool = True,
        enable_db: bool = True,
        enable_api: bool = True,
    ) -> PerceptionSnapshot:
        """按方案 DSL 步骤拆解观测点，采集三维快照并落库/落盘。"""
        enabled = {"page": enable_page, "db": enable_db, "api": enable_api}
        steps = [DSLStep.model_validate(s) for s in (plan.steps or [])]
        evidence_dir = self.evidence_root / f"task_{task.id}" / phase
        evidence_dir.mkdir(parents=True, exist_ok=True)
        ctx = ObservationContext(task_id=task.id, phase=phase, evidence_dir=evidence_dir)

        snapshot = PerceptionSnapshot(task_id=task.id, phase=phase)
        results: dict[str, object] = {}
        for dim, adapter in self.adapters.items():
            if not enabled.get(dim, False):
                continue
            dim_steps = [s for s in steps if _ACTION_TO_DIM.get(s.action) == dim]
            results[dim] = adapter.observe(dim_steps, ctx)
        snapshot.page_result = results.get("page")  # type: ignore[assignment]
        snapshot.db_result = results.get("db")  # type: ignore[assignment]
        snapshot.api_result = results.get("api")  # type: ignore[assignment]
        snapshot.collect()

        # 快照 JSON 留档 + 落库
        snap_path = evidence_dir / "snapshot.json"
        snap_path.write_text(snapshot.model_dump_json(indent=2), encoding="utf-8")
        snapshot.evidence_uris.append(str(snap_path))
        self._persist(snapshot)
        return snapshot

    def _persist(self, snapshot: PerceptionSnapshot) -> None:
        if self.session_factory is None:
            return
        with self.session_factory() as s:
            s.add(PerceptionSnapshotRecord(
                task_id=snapshot.task_id, phase=snapshot.phase,
                snapshot=snapshot.model_dump(mode="json"),
                evidence_uris=snapshot.evidence_uris,
                exception_count=len(snapshot.exceptions)))
            s.commit()

    def load_snapshot(self, task_id: int, phase: PerceptionPhase) -> PerceptionSnapshot | None:
        """从库中读回最近一次指定阶段的快照（供修复后对比）。"""
        if self.session_factory is None:
            return None
        with self.session_factory() as s:
            rec = (s.query(PerceptionSnapshotRecord)
                   .filter_by(task_id=task_id, phase=phase)
                   .order_by(PerceptionSnapshotRecord.id.desc())
                   .first())
            if rec is None:
                return None
            return PerceptionSnapshot.model_validate(rec.snapshot)

    @staticmethod
    def compare(pre: PerceptionSnapshot, post: PerceptionSnapshot) -> SnapshotDiff:
        """对比修复前后快照：哪些异常已消除 / 仍存在 / 新增。"""
        pre_keys = {_exc_key(e): e for e in pre.exceptions}
        post_keys = {_exc_key(e): e for e in post.exceptions}
        resolved = [e for k, e in pre_keys.items() if k not in post_keys]
        persistent = [e for k, e in post_keys.items() if k in pre_keys]
        introduced = [e for k, e in post_keys.items() if k not in pre_keys]
        return SnapshotDiff(resolved, persistent, introduced)
