#!/bin/bash
# scripts/boot.sh — 幂等启动 tg-forwarder：已在运行则直接退出。
# 被 scripts/healthcheck.sh 和平台 cron 调用。
set -euo pipefail

DIR=/home/hatch/workspace/tg-bot-forwarder
MARKER="$DIR/run/last-restart"
PATTERN="node $DIR/bot[.]js"   # [.] 写法避免 pkill/pgrep 误匹配自身

mkdir -p "$DIR/logs" "$DIR/run"

# 已在运行 → 什么都不做
if pgrep -f "$PATTERN" >/dev/null 2>&1; then
  exit 0
fi

# 节流：10 分钟内最多重启一次（防止 token 失效等导致的崩溃循环）
now=$(date +%s)
if [ -f "$MARKER" ]; then
  last=$(cat "$MARKER" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt 600 ]; then
    echo "boot: restarted recently, throttled"
    exit 0
  fi
fi
echo "$now" > "$MARKER"

cd "$DIR"

if [ ! -f .env ]; then
  echo "boot: .env 缺失，无法启动" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

# 后台常驻，日志进 logs/bot.log（nohup + 重定向使其脱离当前会话）
# 注意用绝对路径启动，保证 pgrep 的匹配模式一致
nohup /usr/bin/node "$DIR/bot.js" >>"$DIR/logs/bot.log" 2>&1 &
echo "boot: started tg-forwarder pid $!"
