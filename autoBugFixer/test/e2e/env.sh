# E2E 试验配置：独立 DB / 工作区 / 仿真环境目录（var/ 已 gitignore）
# 用法: . test/e2e/env.sh && .venv/bin/autobugfixer-import ...
# 仓库根从本脚本位置推导（换机器/换路径无需修改）
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
mkdir -p "$REPO_ROOT/var/e2e"
export AUTOBUGFIXER_DATABASE_URL="sqlite:///$REPO_ROOT/var/e2e/autobugfixer.db"
export AUTOBUGFIXER_WORKSPACE_ROOT="$REPO_ROOT/var/e2e/workspaces"
export AUTOBUGFIXER_ENV_ROOT="$REPO_ROOT/var/e2e/testenv"
export AUTOBUGFIXER_USE_GIT_WORKTREE="true"

# DeepSeek 接入（配置 Key 后整条流水线可脱离 OpenAI 真跑）：
# export AUTOBUGFIXER_LLM_MODE="deepseek"          # 分析网关用 DeepSeek（默认 fake）
# export AUTOBUGFIXER_DEEPSEEK_API_KEY="sk-..."    # DeepSeek API Key
# export AUTOBUGFIXER_FIX_DRIVER="deepseek"        # 修复驱动走 DeepSeek（默认 codex）
