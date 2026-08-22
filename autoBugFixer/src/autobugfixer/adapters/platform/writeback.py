"""平台状态回写（11.7）：本系统状态 -> 平台状态的配置化映射。

关键状态迁移时回写缺陷平台；回写失败重试一次并告警，不阻塞主流程。
"""

from __future__ import annotations

import logging

from autobugfixer.adapters.platform import BugPatch
from autobugfixer.features.intervention.notifier import NoticeMessage

logger = logging.getLogger(__name__)


def writeback_platform_status(*, platform, bug, to_state: str, settings, audit, notifier,
                              task_id: int | None = None) -> None:
    """按 status_map 回写平台状态；所有异常吞掉（重试一次后告警），绝不阻塞流水线。"""
    mapped = (settings.status_map or {}).get(to_state)
    if not mapped:
        return
    patch = BugPatch(status=mapped, comment=f"autobugfixer 任务状态: {to_state}")
    last_error: Exception | None = None
    for _ in range(2):  # 首次 + 重试一次
        try:
            platform.update_bug(bug.platform_bug_id, patch)
            audit.log(action="platform_writeback", target=f"bug:{bug.platform_bug_id}",
                      detail={"to_state": to_state, "mapped": mapped}, task_id=task_id)
            return
        except Exception as exc:  # 平台不可用/ Bug 不存在等
            last_error = exc
            logger.warning("平台回写失败（将重试）: %s", exc)
    audit.log(action="platform_writeback_failed", target=f"bug:{bug.platform_bug_id}",
              detail={"to_state": to_state, "error": str(last_error)}, task_id=task_id)
    try:
        notifier.send("ops", NoticeMessage(
            title=f"平台状态回写失败: {bug.platform_bug_id}",
            content=f"目标状态 {to_state}（{mapped}），错误: {last_error}"))
    except Exception:
        pass
