#!/bin/sh
set -e

cd /var/minis/workspace/tg-bot-forwarder

echo "== Telegram 匿名双向传话 Bot 一键部署 =="
echo "ADMIN_ID: 6609386680"
echo ""

if ! command -v vercel >/dev/null 2>&1; then
  echo "未检测到 vercel CLI。"
  echo "请先安装 Node/npm 后执行：npm install -g vercel"
  echo "或直接用 Vercel 网页导入项目。"
  exit 1
fi

echo "1) 先登录 Vercel（如未登录）"
vercel login || true

echo ""
echo "2) 开始部署到 Vercel"
vercel --prod

echo ""
echo "3) 部署完成后，请把生成的域名填到下面命令里设置 Webhook："
echo 'curl -X POST "https://api.telegram.org/bot$TG_BOT_TOKEN/setWebhook?url=https://你的域名.vercel.app/"'
echo ""
echo "4) 记得在 Vercel 项目环境变量中设置："
echo "   TG_BOT_TOKEN = <你的 Bot Token>"
echo "   ADMIN_ID    = 6609386680"
echo "   ECHO_MODE   = true"
echo ""
echo "管理员用法："
echo "- 直接回复机器人转来的消息"
echo "- 或 /reply_用户ID 你的内容"
