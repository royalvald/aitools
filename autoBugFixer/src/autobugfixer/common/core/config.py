"""系统配置（pydantic-settings）。

所有可调项集中在此：评分权重、准入阈值、重试上限、LLM 模式、预算、命令白名单等。
支持通过环境变量（前缀 AUTOBUGFIXER_）或 .env 覆盖。
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """系统全局配置：集中所有可调项，支持环境变量（前缀 AUTOBUGFIXER_）与 .env 覆盖。"""

    model_config = SettingsConfigDict(env_prefix="AUTOBUGFIXER_", env_file=".env", extra="ignore")

    # 数据库
    database_url: str = "sqlite:///./autobugfixer.db"

    # LLM Gateway
    llm_mode: str = "fake"  # fake / anthropic
    anthropic_model: str = "claude-sonnet-4-5"
    anthropic_api_key: str | None = None

    # 预算治理（11.3）
    task_token_budget: int = 100_000  # 单任务 token 预算，超限转人工
    daily_token_budget: int = 1_000_000  # 日总量预算
    stage_max_retry: int = 2  # 单 Stage LLM 调用重试次数

    # 关联仓库画像（FR-PRE-02 增补，Spec 02 §9）：完整性通过后逐仓库 LLM 分析，
    # 结果随 bug_repo 持久化并注入后续 prompt；关闭时下游回退基础仓库信息
    repo_profile_enabled: bool = True

    # 评分（FR-PRE-04）：三维权重 + 准入阈值（v1 引擎，默认）
    score_weight_fix: float = 0.4  # 解决难度
    score_weight_verify: float = 0.3  # 回归验证难度
    score_weight_change: float = 0.3  # 改动项规模
    admission_threshold: float = 60.0  # 综合分 < 阈值进入自动流程

    # 评分 v2 引擎（Spec 04 §8：rubric + AI 判定表单 + 本地映射）
    scoring_engine: str = "v1"  # v1（LLM 直接打分，as-built）/ v2（尺子在本地）
    # v2 四维权重（定位/修改/验证/波及，建议起点 0.3/0.3/0.2/0.2，经评审定）
    score_v2_weight_locate: float = 0.3
    score_v2_weight_fix: float = 0.3
    score_v2_weight_verify: float = 0.2
    score_v2_weight_blast: float = 0.2

    # 重试（11.5）
    max_retry: int = 3
    max_info_rounds: int = 2  # 信息补充往返上限，超过转 MANUAL

    # 高风险模块清单（FR-PRE-03 方案需人工确认）
    high_risk_modules: list[str] = Field(default_factory=lambda: ["core-payment", "auth"])

    # 环境锁（11.1）
    env_lock_lease_seconds: int = 30 * 60

    # 任务认领租约（并发互斥）：调度器/API/webhook 并发驱动同一任务时的双驱防护
    task_claim_lease_seconds: int = 15 * 60

    # 命令白名单模板（FR-REG-01），支持 {param} 占位
    cmd_whitelist: list[str] = Field(
        default_factory=lambda: [
            "echo {text}",
            "systemctl restart {service}",
            "systemctl stop {service}",
            "systemctl start {service}",
            "tail -n {n} {log}",
        ]
    )

    # 修复出口侧静态校验（11.2）：禁改路径（glob）
    forbidden_paths: list[str] = Field(
        default_factory=lambda: [".env", "*.key", "*.pem", "deploy/*", "secrets/*"]
    )

    # 凭据加密主密钥（Fernet，生产走环境变量/KMS）
    fernet_key: str | None = None

    # 工作区与仿真环境根目录（本地开发用）
    workspace_root: str = "./var/workspaces"
    env_root: str = "./var/testenv"

    # 适配器注册（6.2 配置驱动）：bug 平台与环境执行器按名字实例化
    bug_platform: str = "mock"  # mock / jira / zentao（csv 走导入通道）
    bug_platform_config: dict = Field(default_factory=dict)

    # 修复驱动（Spec 05）：codex exec 子进程（唯一通道）
    codex_executable: str = "codex"
    codex_model: str | None = None  # 未配置时用 codex CLI 默认模型
    codex_timeout: float = 600.0
    codex_sandbox: str = "workspace-write"  # 进程只能写工作区内文件，网络默认禁用

    # 三维感知（FR-FIX-02，P1）：默认关闭保持轻量
    perception_enabled: bool = False
    perception_base_url: str = "http://127.0.0.1:8000"
    perception_evidence_root: str = "./var/evidence"

    # 通知器：log / im（企业微信/钉钉群机器人 webhook）
    notifier_type: str = "log"
    im_webhook_url: str | None = None
    im_kind: str = "wecom"  # wecom / dingtalk

    # 平台状态回写映射（11.7）：本系统状态 -> 平台状态
    status_map: dict[str, str] = Field(default_factory=lambda: {
        "CLOSED": "已关闭", "WAIT_INFO": "待补充", "MANUAL": "处理中-转人工",
    })

    # git 受控分支工作区（git worktree + autofix/<bug-id>）；不可用自动回退目录快照
    use_git_worktree: bool = False

    # 常驻调度器
    scheduler_poll_interval_seconds: int = 60
    scheduler_dispatch_limit: int = 2  # 单轮按优先级出队调度的任务数上限
    intervention_sla_hours: float = 24.0  # 介入单 SLA：临期提醒、超时升级
    intervention_remind_before_hours: float = 2.0  # 截止前多久提醒
    intervention_escalation: str = "remind"  # 超时动作：remind（提醒上级）/ suspend（挂起任务）


@lru_cache
def get_settings() -> Settings:
    """返回单例 Settings（lru_cache 缓存，进程内共享同一实例）。"""
    return Settings()
