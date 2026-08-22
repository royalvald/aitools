"""三维 Bug 表现感知（FR-FIX-02，设计文档 4.2.2）。

页面层 / 数据库层 / 接口层三个感知适配器，修复前采基线快照（pre_fix）、
修复后采对比快照（post_fix），快照作为修复指令输入与验证比对依据。
"""

from .base import (
    APIObservation,
    DBObservation,
    ObservationContext,
    PageObservation,
    PerceptionAdapter,
    PerceptionException,
    PerceptionSnapshot,
    StepObservation,
)
from .api_layer import APIPerception
from .db_layer import DBPerception
from .page import PagePerception
from .service import PerceptionService, PerceptionSnapshotRecord, SnapshotDiff

__all__ = [
    "APIObservation",
    "APIPerception",
    "DBObservation",
    "DBPerception",
    "ObservationContext",
    "PageObservation",
    "PagePerception",
    "PerceptionAdapter",
    "PerceptionException",
    "PerceptionService",
    "PerceptionSnapshot",
    "PerceptionSnapshotRecord",
    "SnapshotDiff",
    "StepObservation",
]
