"""构建部署产物：渲染健康检查快照 api/_health.json（模拟部署包内的运行时快照）。

探活面板当前读数：8/8 依赖健康、1 条可容忍告警。
"""

import json
from pathlib import Path

from demo_shop.health import WARNING_THRESHOLD, service_status

HEALTHY_CHECKS = 8
TOTAL_CHECKS = 8
WARNINGS = 1


def build() -> dict:
    """按当前源码逻辑渲染健康检查产物并写回 api/_health.json。"""
    status = service_status(HEALTHY_CHECKS, TOTAL_CHECKS, WARNINGS)
    payload = {
        "status": status,
        "http_status": 200 if status in ("ok", "degraded") else 503,
        "healthy_checks": HEALTHY_CHECKS,
        "total_checks": TOTAL_CHECKS,
        "warnings": WARNINGS,
        "warning_threshold": WARNING_THRESHOLD,
    }
    out = Path(__file__).parent / "api" / "_health.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    return payload


if __name__ == "__main__":
    print(json.dumps(build(), ensure_ascii=False))
