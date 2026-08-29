"""E2E 环境种子：向试验库写入 local 仿真环境行（幂等）。

用法: . test/e2e/env.sh && .venv/bin/python test/e2e/seed_env.py
"""

from autobugfixer.common.core.config import get_settings
from autobugfixer.common.core.db import init_db, make_engine, make_session_factory
from autobugfixer.common.core.models import Environment


def main() -> None:
    settings = get_settings()
    engine = make_engine(settings.database_url)
    init_db(engine)
    factory = make_session_factory(engine)
    with factory() as s:
        existing = (s.query(Environment)
                    .filter_by(name="local-sim").one_or_none())
        if existing is None:
            # local 仿真环境：部署脚本须命中全局白名单（echo {text}，参数单 token）
            env = Environment(
                name="local-sim", type="local", conn_config={},
                credential_ref="", cmd_whitelist=[],
                deploy_script=["echo deploy-demo-shop", "echo warmup-healthcheck"])
            s.add(env)
            s.commit()
            print(f"已写入环境: local-sim (id={env.id})")
        else:
            print(f"环境已存在: local-sim (id={existing.id})")


if __name__ == "__main__":
    main()
