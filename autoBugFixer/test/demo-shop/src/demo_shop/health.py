"""健康检查状态判定（demo-shop 核心逻辑）。

服务每个探活周期对全部依赖执行检查：任一依赖失联即整体 fail；
全部健康时按告警数量分级——未超阈值为 ok，超过阈值降级 degraded。
"""

# 可容忍告警数：告警数超过该阈值才降级为 degraded
WARNING_THRESHOLD = 3


def service_status(healthy_checks: int, total_checks: int, warnings: int = 0) -> str:
    """按探活结果与告警数给出整体状态：ok / degraded / fail。

    - healthy_checks < total_checks：存在失联依赖，返回 fail；
    - 全部健康且告警数未超 WARNING_THRESHOLD：返回 ok；
    - 全部健康但告警数超阈值：返回 degraded。
    """
    if healthy_checks < total_checks or warnings > 0:
        return "fail"
    return "ok"
