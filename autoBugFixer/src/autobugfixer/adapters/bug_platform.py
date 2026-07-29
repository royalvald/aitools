"""缺陷平台适配器（FR-PRE-01，设计文档 6.2）。

MockBugPlatform：内存数据集，供本地开发与 CI 使用。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Protocol

from pydantic import BaseModel, Field


class BugTicketData(BaseModel):
    """适配器层标准化 Bug 传输对象（入库前）。"""

    platform: str = "mock"
    platform_bug_id: str
    title: str = ""
    description: str = ""
    repro_steps: str = ""
    expected: str = ""
    actual: str = ""
    env_version: str = ""
    attachments: list[str] = Field(default_factory=list)
    repo_url: str = ""
    repo_branch: str = "main"
    affected_modules: list[str] = Field(default_factory=list)
    raw_payload: dict = Field(default_factory=dict)

    @property
    def missing_fields(self) -> list[str]:
        """关键字段缺失标记，供完整性分析使用（FR-PRE-01 规则）。"""
        required = {
            "title": self.title, "description": self.description,
            "repro_steps": self.repro_steps, "expected": self.expected,
            "actual": self.actual, "env_version": self.env_version,
        }
        return [name for name, value in required.items() if not value]


class BugPatch(BaseModel):
    """平台回写（状态映射按平台配置化，11.7）。"""

    status: str | None = None
    comment: str | None = None
    fields: dict = Field(default_factory=dict)


class BugPlatformAdapter(Protocol):
    """缺陷平台适配器协议（FR-PRE-01）：拉取、查询、回写三类操作的统一契约。"""

    def list_bugs(self, since: datetime | None = None) -> list[BugTicketData]:
        """列出 Bug（可按增量时间过滤），返回标准化数据对象列表。"""
        ...

    def get_bug(self, bug_id: str) -> BugTicketData:
        """按平台 Bug 编号查询单条详情。"""
        ...

    def update_bug(self, bug_id: str, patch: BugPatch) -> None:
        """回写状态/评论/字段到平台（11.7 状态映射）。"""
        ...


class MockBugPlatform:
    """内存数据集 Mock（含示例 Bug），支持 webhook 事件模拟。"""

    def __init__(self, bugs: list[BugTicketData] | None = None) -> None:
        self._bugs: dict[str, BugTicketData] = {b.platform_bug_id: b for b in (bugs or sample_bugs())}
        self.updates: list[tuple[str, BugPatch]] = []  # 回写留痕

    def list_bugs(self, since: datetime | None = None) -> list[BugTicketData]:
        """返回全部 Bug（since 参数仅作契约兼容，Mock 忽略）。"""
        return list(self._bugs.values())

    def get_bug(self, bug_id: str) -> BugTicketData:
        """按编号取 Bug；不存在抛 KeyError。"""
        if bug_id not in self._bugs:
            raise KeyError(f"平台 Bug 不存在: {bug_id}")
        return self._bugs[bug_id]

    def update_bug(self, bug_id: str, patch: BugPatch) -> None:
        """回写补丁并记录到 updates 留痕，fields 中的已知字段同步到对象。"""
        self.get_bug(bug_id)  # 不存在则抛错
        self.updates.append((bug_id, patch))
        for key, value in patch.fields.items():
            if hasattr(self._bugs[bug_id], key):
                setattr(self._bugs[bug_id], key, value)

    def upsert_bug(self, data: BugTicketData) -> None:
        """webhook 事件接入时同步平台侧数据（事件源自平台，Bug 必然存在）。"""
        self._bugs[data.platform_bug_id] = data

    # Mock 辅助：模拟人工在平台侧补充了信息
    def apply_human_supplement(self, bug_id: str, fields: dict) -> None:
        """模拟人工在平台侧补充信息（测试 WAIT_INFO 唤醒链路用）。"""
        bug = self.get_bug(bug_id)
        for key, value in fields.items():
            setattr(bug, key, value)


def sample_bugs() -> list[BugTicketData]:
    """示例数据集：1 条完整可自动修复、1 条缺信息、1 条高风险模块。"""
    return [
        BugTicketData(
            platform_bug_id="BUG-1001",
            title="健康检查接口返回 fail",
            description="测试环境 /health 接口返回 status=fail，应为 ok。",
            repro_steps="1. 部署应用\n2. 调用 GET /health\n3. 观察返回 status 字段",
            expected="status 为 ok",
            actual="status 为 fail",
            env_version="v1.2.0 / python3.11",
            repo_url="mock://repo/demo",
            repo_branch="main",
            affected_modules=["web"],
        ),
        BugTicketData(
            platform_bug_id="BUG-1002",
            title="页面白屏",
            description="用户反馈打开首页白屏。",
            # 缺 repro_steps/expected/actual/env_version：触发信息补充介入
            affected_modules=["web"],
        ),
        BugTicketData(
            platform_bug_id="BUG-1003",
            title="支付回调偶发重复入账",
            description="核心交易链路：支付回调在超时重试场景下重复入账。",
            repro_steps="1. 构造超时回调\n2. 重放同一回调\n3. 查询账户流水",
            expected="同一笔回调只入账一次",
            actual="出现两条入账记录",
            env_version="v2.0.1",
            repo_url="mock://repo/pay",
            repo_branch="main",
            affected_modules=["core-payment"],  # 高风险：验证方案需人工确认
        ),
    ]
