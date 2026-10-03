#!/bin/bash
# scripts/healthcheck.sh — 每 15 分钟由平台 cron 调用。
# 健康则静默退出；不健康则杀掉残留进程并拉起。
set -euo pipefail

DIR=/home/hatch/workspace/tg-bot-forwarder
PATTERN="node $DIR/bot[.]js"

if curl -sf --max-time 8 http://127.0.0.1:8787/health >/dev/null 2>&1; then
  exit 0
fi

echo "healthcheck: bot 不健康，准备重启"
# 先杀掉可能卡死的残留进程（[.] 写法避免误杀自身）
pkill -f "$PATTERN" 2>/dev/null || true
sleep 2

exec "$DIR/scripts/boot.sh"
