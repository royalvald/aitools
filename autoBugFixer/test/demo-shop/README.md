# demo-shop 迷你订单服务

供 autoBugFixer 做端到端真实流程验证的小型项目：一个真实 git 仓库，
包含真实业务代码、真实注入的缺陷与真实失败的单测。

## 项目结构

```
src/demo_shop/health.py   健康检查状态判定（探活 + 告警阈值）
src/demo_shop/orders.py   订单内存分页
build.py                  构建部署产物：渲染 api/_health.json（模拟部署包内运行时快照）
api/_health.json          已构建的部署产物（验证 DSL 本地仿真按 GET /health 读取它）
logs/app.log              服务日志样例
tests/                    pytest 单测（编码预期契约）
```

## 约定：api/ 目录即部署产物

本项目按"静态构建产物"风格发布：`build.py` 根据源码逻辑渲染 `api/_health.json`，
部署时该文件随包发布。验证 DSL 的本地仿真会把 `call_api GET /health`
映射为读取环境目录下 `api/_health.json`，因此验证阶段断言的就是
真实构建出的产物内容。

## 常用命令

```bash
# 运行单测（无需安装，conftest.py 已把 src 加入 sys.path）
python -m pytest tests/ -q

# 重新构建健康检查产物
PYTHONPATH=src python build.py
```
