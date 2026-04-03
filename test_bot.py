#!/usr/bin/env python3
"""
Telegram Bot 测试脚本
检查 Token 是否有效，获取 Bot 信息
"""

import os
import sys
import requests

# 配置
BOT_TOKEN = os.environ.get("TG_BOT_TOKEN", "")
if not BOT_TOKEN:
    print("❌ TG_BOT_TOKEN 未设置")
    print("请设置环境变量或直接在脚本中配置")
    
    # 尝试从 .env 读取
    try:
        with open(".env", "r") as f:
            for line in f:
                if line.startswith("TG_BOT_TOKEN="):
                    BOT_TOKEN = line.split("=", 1)[1].strip().strip('"\'')
                    break
    except:
        pass
    
    if not BOT_TOKEN:
        BOT_TOKEN = input("请输入 Bot Token: ").strip()

def test_bot_token():
    """测试 Bot Token 是否有效"""
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/getMe"
    print(f"测试链接: {url[:40]}...")
    
    try:
        res = requests.get(url, timeout=10)
        data = res.json()
        
        if data.get("ok"):
            bot = data["result"]
            print("✅ Bot Token 有效！")
            print(f"🤖 Bot: @{bot['username']} ({bot['first_name']})")
            print(f"🔗 链接: https://t.me/{bot['username']}")
            return bot
        else:
            print(f"❌ 错误: {data.get('description', '未知错误')}")
            return None
    except Exception as e:
        print(f"❌ 连接失败: {e}")
        return None

def get_webhook_info():
    """获取当前 Webhook 状态"""
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/getWebhookInfo"
    try:
        res = requests.get(url, timeout=10)
        data = res.json()
        
        if data.get("ok"):
            info = data["result"]
            print("\n🌐 Webhook 状态:")
            print(f"    URL: {info.get('url', '未设置')}")
            print(f"    待处理更新: {info.get('pending_update_count', 0)}")
            print(f"    最后错误: {info.get('last_error_message', '无')}")
        return data
    except Exception as e:
        print(f"❌ 获取 Webhook 失败: {e}")
        return None

def send_test_message(chat_id):
    """发送测试消息到指定用户"""
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    text = "🤖 Bot 测试消息\n\n你的管理员 ID: 6609386680\nBot 已启动，可以开始双向传话！"
    
    try:
        res = requests.post(url, json={
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML"
        })
        data = res.json()
        
        if data.get("ok"):
            print(f"✅ 测试消息已发送到 {chat_id}")
        else:
            print(f"❌ 发送失败: {data}")
    except Exception as e:
        print(f"❌ 发送失败: {e}")

if __name__ == "__main__":
    print("="*50)
    print("Telegram Bot 测试工具")
    print("="*50)
    
    bot = test_bot_token()
    if not bot:
        sys.exit(1)
    
    get_webhook_info()
    
    print("\n📝 测试选项:")
    print("1. 发送测试消息给自己 (需要 chat_id)")
    choice = input("选择 (直接回车跳过): ").strip()
    
    if choice == "1":
        chat_id = input("请输入你的 chat_id（数字）: ").strip()
        if chat_id.isdigit() or (chat_id.startswith("-") and chat_id[1:].isdigit()):
            send_test_message(chat_id)
    
    print("\n" + "="*50)
    print("📋 部署检查清单:")
    print("  ✅ Bot Token 有效")
    print(f"  ⚙️  管理员 ID: 6609386680")
    print(f"  🤖 Bot 用户名: @{bot.get('username')}")
    print(f"  🔗 分享链接: https://t.me/{bot.get('username')}")
    print("  🚀 部署方式:")
    print("    1. 运行 ./deploy.sh")
    print("    2. 或部署到 Vercel")
    print("    3. 设置 Webhook")
    print("="*50)