"""数据模型（对应设计文档 5.1 节，字段适度精简）。

大对象（diff、原始日志）按设计应走文件存储存 URI，首期从简直接落 JSON/TEXT 字段。
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from autobugfixer.common.core.db import Base


def utcnow() -> datetime:
    """返回当前 UTC 时间（带时区），作为所有表 created_at/updated_at 的默认值。"""
    return datetime.now(timezone.utc)


class BugTicket(Base):
    """标准化 Bug（FR-PRE-01 输出）。"""

    __tablename__ = "bug_ticket"

    id: Mapped[int] = mapped_column(primary_key=True)
    platform: Mapped[str] = mapped_column(String(50))
    platform_bug_id: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(500), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    repro_steps: Mapped[str] = mapped_column(Text, default="")
    expected: Mapped[str] = mapped_column(Text, default="")
    actual: Mapped[str] = mapped_column(Text, default="")
    env_version: Mapped[str] = mapped_column(String(200), default="")
    attachments: Mapped[list] = mapped_column(JSON, default=list)
    repo_url: Mapped[str] = mapped_column(String(500), default="")
    repo_branch: Mapped[str] = mapped_column(String(200), default="main")
    affected_modules: Mapped[list] = mapped_column(JSON, default=list)
    missing_fields: Mapped[list] = mapped_column(JSON, default=list)
    raw_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Repo(Base):
    """全局仓库登记表（Spec 01 §10）：独立于 Bug 的共享资产。

    仓库信息不挂在单个 Bug 下——登记（CLI/API 手动，或 Bug 声明自动）时做
    本地可用性校验；LLM 画像（summary/tech_stack/key_dirs/entry_points，
    仓库固有事实、不含任何 Bug 上下文）一次生成全局复用，手动刷新
    （Spec 02 §9 v2）。Bug 经 planning 的 target_repos 判定引用登记表条目
    （Spec 02 §9 v3：对应关系随方案输出一并产生）。
    """

    __tablename__ = "repo"
    __table_args__ = (
        Index("ux_repo_path_branch", "path", "branch", unique=True),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    path: Mapped[str] = mapped_column(String(500), default="")
    branch: Mapped[str] = mapped_column(String(200), default="main")
    is_git: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="unavailable")  # available/unavailable
    fail_reason: Mapped[str] = mapped_column(String(500), default="")
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # LLM 画像（仓库固有事实）：summary/tech_stack/key_dirs/entry_points；
    # 空表示未画像（登记时未带 LLM / 尚未补齐），首次被引用时补齐
    profile: Mapped[dict] = mapped_column(JSON, default=dict, nullable=True)
    profiled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    source: Mapped[str] = mapped_column(String(20), default="manual")  # manual/auto/migrated
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class BugRepo(Base):
    """Bug ↔ 全局仓库关联（Spec 01 §10）：链接 + 本 Bug 维度的相关性判定。

    仓库事实（可用性/画像）在全局 repo 表，本表只维护链接：
    - origin: declared（用户在 Bug 单声明）/ matched（planning target_repos 补选）；
    - seq: 声明顺序（matched 链接排在声明之后）；
    - relevance: planning 判定给出的"该仓库与本 Bug 的关联"依据（提示性）。
    """

    __tablename__ = "bug_repo"

    id: Mapped[int] = mapped_column(primary_key=True)
    bug_ticket_id: Mapped[int] = mapped_column(ForeignKey("bug_ticket.id"), index=True)
    repo_id: Mapped[int] = mapped_column(ForeignKey("repo.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer, default=0)  # 保持给定顺序
    origin: Mapped[str] = mapped_column(String(20), default="declared")
    relevance: Mapped[str] = mapped_column(String(500), default="")  # 本 Bug 相关性（LLM 判定）
    matched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    repo: Mapped["Repo"] = relationship(lazy="joined")


class Task(Base):
    """任务实例（状态机载体）。"""

    __tablename__ = "task"

    id: Mapped[int] = mapped_column(primary_key=True)
    bug_ticket_id: Mapped[int] = mapped_column(ForeignKey("bug_ticket.id"))
    state: Mapped[str] = mapped_column(String(30), index=True)
    priority_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    score_detail: Mapped[dict] = mapped_column(JSON, default=dict)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    max_retry: Mapped[int] = mapped_column(Integer, default=3)
    info_rounds: Mapped[int] = mapped_column(Integer, default=0)  # 信息补充往返次数
    current_stage: Mapped[str] = mapped_column(String(50), default="")
    environment_id: Mapped[int | None] = mapped_column(ForeignKey("environment.id"), nullable=True)
    # 任务认领租约（并发互斥，naive UTC）：非空且未过期 = 某执行者正在推进本任务
    claimed_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TaskStateHistory(Base):
    """状态迁移历史（断点续跑 + 审计回放）。"""

    __tablename__ = "task_state_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("task.id"), index=True)
    from_state: Mapped[str | None] = mapped_column(String(30), nullable=True)
    to_state: Mapped[str] = mapped_column(String(30))
    stage: Mapped[str] = mapped_column(String(50), default="")
    message: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class VerificationPlan(Base):
    """回归验证方案（11.4 DSL 结构化步骤）。"""

    __tablename__ = "verification_plan"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("task.id"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    dsl_version: Mapped[str] = mapped_column(String(20), default="1.0")
    env_requirements: Mapped[str] = mapped_column(Text, default="")
    steps: Mapped[list] = mapped_column(JSON, default=list)  # DSL 步骤
    expected_results: Mapped[list] = mapped_column(JSON, default=list)
    function_points: Mapped[list] = mapped_column(JSON, default=list)
    regression_scope: Mapped[str] = mapped_column(Text, default="")
    fix_approach: Mapped[dict] = mapped_column(JSON, default=dict)  # 修复思路大纲（Spec 03 §9.4）
    proposed_skills: Mapped[list] = mapped_column(JSON, default=list)  # 提议技能快照（Spec 03 §8）
    risk_level: Mapped[str] = mapped_column(String(20), default="low")
    confirmed_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FixRecord(Base):
    """修复记录（FR-FIX-01 留痕，prompt 快照供审计回放）。"""

    __tablename__ = "fix_record"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("task.id"), index=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    branch: Mapped[str] = mapped_column(String(200), default="")
    worktree: Mapped[str] = mapped_column(String(500), default="")
    prompt_version: Mapped[str] = mapped_column(String(50), default="")
    prompt_snapshot: Mapped[str] = mapped_column(Text, default="")
    changed_files: Mapped[list] = mapped_column(JSON, default=list)
    diff: Mapped[str] = mapped_column(Text, default="")
    diff_hash: Mapped[str] = mapped_column(String(64), default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    raw_log: Mapped[str] = mapped_column(Text, default="")
    experience_hit: Mapped[bool] = mapped_column(Boolean, default=False)  # 修复指令命中经验库
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DeployRecord(Base):
    """部署记录：部署状态与执行步骤留痕（成功/失败/已回滚）。"""

    __tablename__ = "deploy_record"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("task.id"), index=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    prev_version: Mapped[str] = mapped_column(String(200), default="")
    status: Mapped[str] = mapped_column(String(20), default="pending")  # success/failed/rolled_back
    steps_log: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class VerifyRecord(Base):
    """验证记录（FR-REG-03 结论与证据）。"""

    __tablename__ = "verify_record"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("task.id"), index=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    plan_version: Mapped[int] = mapped_column(Integer, default=1)
    conclusion: Mapped[str] = mapped_column(String(20), default="")  # passed / failed
    step_results: Mapped[list] = mapped_column(JSON, default=list)
    risk_notes: Mapped[str] = mapped_column(Text, default="")  # 感知对比新增异常等风险备注
    evidence_uris: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Intervention(Base):
    """人工介入单（4.5 统一介入模型）。"""

    __tablename__ = "intervention"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("task.id"), index=True)
    type: Mapped[str] = mapped_column(String(30))  # info_supplement/plan_confirm/discussion/optimization
    title: Mapped[str] = mapped_column(String(500), default="")
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    assignee_role: Mapped[str] = mapped_column(String(50), default="developer")
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)  # pending/resolved/timeout
    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Experience(Base):
    """修复经验库（FR-MEM-01）。"""

    __tablename__ = "experience"
    # 活跃条目去重唯一索引（Spec 08 §7：防并发重复插入；仅约束 status='active' 行，
    # 退役条目不受限）。upsert 查询键与此对齐。
    __table_args__ = (
        Index("ux_experience_active_dedup", "category", "problem_signature",
              unique=True, sqlite_where=text("status = 'active'")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    category: Mapped[str] = mapped_column(String(50), index=True)
    problem_signature: Mapped[str] = mapped_column(String(500), default="")
    symptoms: Mapped[str] = mapped_column(Text, default="")
    root_cause_pattern: Mapped[str] = mapped_column(Text, default="")
    fix_pattern: Mapped[str] = mapped_column(Text, default="")
    verification_points: Mapped[str] = mapped_column(Text, default="")
    applicable_conditions: Mapped[str] = mapped_column(Text, default="")
    hit_count: Mapped[int] = mapped_column(Integer, default=0)
    source_task_ids: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default="active")
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class AuditLog(Base):
    """审计日志：追加写，不落更新（保留 >=180 天）。"""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    actor: Mapped[str] = mapped_column(String(100), default="system")
    action: Mapped[str] = mapped_column(String(100), index=True)
    target: Mapped[str] = mapped_column(String(200), default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Environment(Base):
    """测试环境配置（凭据引用密文）。"""

    __tablename__ = "environment"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    type: Mapped[str] = mapped_column(String(30), default="local")  # local/ssh/docker/k8s
    conn_config: Mapped[dict] = mapped_column(JSON, default=dict)
    credential_ref: Mapped[str] = mapped_column(Text, default="")  # Fernet 密文
    cmd_whitelist: Mapped[list] = mapped_column(JSON, default=list)
    deploy_script: Mapped[list] = mapped_column(JSON, default=list)  # 声明式部署步骤


class EnvLock(Base):
    """环境锁（11.1）：environment_id 粒度互斥，带租约。"""

    __tablename__ = "env_lock"

    id: Mapped[int] = mapped_column(primary_key=True)
    env_id: Mapped[int] = mapped_column(ForeignKey("environment.id"), unique=True, index=True)
    holder_task_id: Mapped[int] = mapped_column(ForeignKey("task.id"))
    acquired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class LeaderLock(Base):
    """调度器 leader 锁（P0-4）：DB 租约实现，多实例部署时同轮只有一个调度者生效。

    单行表（name 唯一），holder 为实例级随机 token；租约到期自动可被抢占，
    无外部组件依赖（与 EnvLock 同一套租约语义）。
    """

    __tablename__ = "leader_lock"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    holder: Mapped[str] = mapped_column(String(100), default="")
    acquired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class LLMUsage(Base):
    """LLM 调用计量（11.3）。"""

    __tablename__ = "llm_usage"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    stage: Mapped[str] = mapped_column(String(50), default="")
    model: Mapped[str] = mapped_column(String(100), default="")
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    cost_est: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class InapplicableCase(Base):
    """不适用场景（FR-MEM-02，P1 占位）。"""

    __tablename__ = "inapplicable_case"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("task.id"), index=True)
    condition_desc: Mapped[str] = mapped_column(Text, default="")
    reason: Mapped[str] = mapped_column(Text, default="")
    discussion_topic: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="open")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class StrategyVersion(Base):
    """策略版本（FR-SYS-02）：评分权重/阈值等策略的版本化快照，支持回退。"""

    __tablename__ = "strategy_version"

    id: Mapped[int] = mapped_column(primary_key=True)
    version: Mapped[int] = mapped_column(Integer, unique=True)
    weights: Mapped[dict] = mapped_column(JSON, default=dict)  # fix/verify/change 权重 + threshold
    active: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    source_intervention_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class VerificationSkill(Base):
    """验证技能库（Spec 03 §8：AI 自主技能沉淀——验证侧经验库）。

    技能 = 命名 + 参数签名 + 步骤模板（仅 9 基础动作组合，支持 {param} 占位）；
    提议技能首次仅内联展开落库，验证通过后由学习阶段蒸馏入库；引用技能的方案
    保存时展开为原始步骤——执行与技能库后续变更完全解耦。
    """

    __tablename__ = "verification_skill"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    params_signature: Mapped[str] = mapped_column(String(200), default="")  # 逗号分隔形参
    desc: Mapped[str] = mapped_column(Text, default="")
    template_steps: Mapped[list] = mapped_column(JSON, default=list)  # 带 {param} 占位的步骤模板
    version: Mapped[int] = mapped_column(Integer, default=1)
    use_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="active")  # active/disabled
    source_task_ids: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
