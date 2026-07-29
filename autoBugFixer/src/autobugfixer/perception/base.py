"""感知模块基础定义：快照数据模型与适配器协议（设计文档 4.2.2）。

三个感知维度（页面/数据库/接口）各自产出 Observation，由 PerceptionService
汇总为 PerceptionSnapshot；异常统一抽象为 PerceptionException，供 pre/post 对比。
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

from autobugfixer.pipeline.dsl import DSLStep

# 快照阶段：修复前基线 / 修复后对比
PerceptionPhase = Literal["pre_fix", "post_fix"]


def utcnow() -> datetime:
    """返回当前 UTC 时间（带时区），作为快照采集时间默认值。"""
    return datetime.now(timezone.utc)


class PerceptionException(BaseModel):
    """一次观测到的 Bug 表现异常（三维统一抽象，compare 以 dimension+kind+key 判等）。"""

    dimension: str  # page / db / api
    kind: str  # render_error/element_missing/interaction_failed/readonly_rejected/
    # sql_error/assert_failed/status_error/error_body/timeout/request_failed
    key: str = ""  # 定位标识：selector / sql / "METHOD path"
    detail: str = ""
    evidence_uri: str = ""  # 原始证据（截屏/HTML/响应体）文件 URI


class StepObservation(BaseModel):
    """单条回放步骤的观测结果（与 DSL StepResult 同构，Pydantic 化便于落 JSON）。"""

    action: str
    target: str = ""  # url / selector / sql / path
    passed: bool = True
    detail: str = ""


class PageObservation(BaseModel):
    """页面层观测：渲染异常、元素缺失、交互失效 + 截屏。"""

    mode: str = ""  # playwright / httpx（缺 playwright 包时降级）
    url: str = ""
    status_code: int | None = None
    screenshot_uri: str = ""  # 截屏证据（httpx 降级模式无截屏）
    html_uri: str = ""  # 页面 HTML 留档
    steps: list[StepObservation] = Field(default_factory=list)
    exceptions: list[PerceptionException] = Field(default_factory=list)


class DBCheckpoint(BaseModel):
    """数据库检查点结果：只读 SQL 执行与完整性/一致性判定。"""

    sql: str
    row_count: int = 0
    sample: list[dict] = Field(default_factory=list)  # 前若干行样本（截断）
    passed: bool = True
    detail: str = ""


class DBObservation(BaseModel):
    """数据库层观测：记录完整性/一致性检查结果。"""

    checkpoints: list[DBCheckpoint] = Field(default_factory=list)
    exceptions: list[PerceptionException] = Field(default_factory=list)


class APICall(BaseModel):
    """一次接口回放的观测结果。"""

    method: str
    path: str
    status_code: int | None = None
    elapsed_ms: float = 0.0
    attempts: int = 1  # 含一次重试
    body_excerpt: str = ""  # 错误报文摘要（截断）


class APIObservation(BaseModel):
    """接口层观测：异常状态码、错误报文、超时。"""

    calls: list[APICall] = Field(default_factory=list)
    exceptions: list[PerceptionException] = Field(default_factory=list)


class PerceptionSnapshot(BaseModel):
    """一次采集的完整快照（修复前基线或修复后对比）。"""

    task_id: int
    phase: PerceptionPhase
    page_result: PageObservation | None = None
    db_result: DBObservation | None = None
    api_result: APIObservation | None = None
    exceptions: list[PerceptionException] = Field(default_factory=list)  # 三维异常汇总清单
    evidence_uris: list[str] = Field(default_factory=list)  # 原始证据 URI 清单
    captured_at: datetime = Field(default_factory=utcnow)

    def collect(self) -> None:
        """从各维度 Observation 汇总异常清单与证据 URI（service 采集完成后调用）。"""
        self.exceptions = []
        self.evidence_uris = []
        for obs in (self.page_result, self.db_result, self.api_result):
            if obs is None:
                continue
            self.exceptions.extend(obs.exceptions)
            for exc in obs.exceptions:
                if exc.evidence_uri:
                    self.evidence_uris.append(exc.evidence_uri)
        if self.page_result is not None:
            for uri in (self.page_result.screenshot_uri, self.page_result.html_uri):
                if uri:
                    self.evidence_uris.append(uri)


class ObservationContext(BaseModel):
    """单次采集的上下文：证据落盘目录等。"""

    model_config = {"arbitrary_types_allowed": True}

    task_id: int
    phase: PerceptionPhase
    evidence_dir: Path  # 本阶段证据目录（service 已创建）


class PerceptionAdapter(Protocol):
    """感知适配器协议：注册制，新增维度实现本协议即可，不改核心流程（4.2.2）。"""

    dimension: str  # page / db / api / ...

    def observe(self, steps: list[DSLStep], ctx: ObservationContext) -> Any:
        """按本维度相关的 DSL 步骤执行观测，返回对应 Observation（无步骤时返回 None）。"""
        ...
