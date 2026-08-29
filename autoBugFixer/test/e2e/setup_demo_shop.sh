#!/usr/bin/env bash
# 重建 test/demo-shop 的本地 git 仓库（外层仓库以纯目录分发，无法携带嵌套 .git）。
# 幂等：已有 git 仓库时跳过。E2E 前必须先跑（仓库门禁要求 main 分支可解析）。
set -euo pipefail
cd "$(dirname "$0")/../demo-shop"

if [ -d .git ]; then
  echo "demo-shop 已是 git 仓库，跳过"
  exit 0
fi

git init -q -b main
git add -A
git -c user.name="iris" -c user.email="iris@local" \
  commit -q -m "init: 迷你订单服务 v1.0.0（含健康检查与分页缺陷）"
git log --oneline
