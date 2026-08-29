"""健康检查状态判定的预期契约（编码 README/模块 docstring 承诺的语义）。"""

from demo_shop.health import service_status


def test_all_healthy_with_tolerable_warning_is_ok():
    """全部健康、告警未超阈值 -> ok。"""
    assert service_status(8, 8, warnings=1) == "ok"


def test_warnings_beyond_threshold_degrade():
    """全部健康、告警超阈值 -> degraded（不是 fail）。"""
    assert service_status(8, 8, warnings=4) == "degraded"


def test_unhealthy_dependency_is_fail():
    """存在失联依赖 -> fail。"""
    assert service_status(7, 8, warnings=0) == "fail"
