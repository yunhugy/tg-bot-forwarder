# Telegram 匿名双向传话 Bot

一个部署在 Vercel/Cloudflare Workers 的无服务器 Telegram Bot，实现用户 ↔ Bot ↔ 管理员的双向匿名传话。

## ✨ 功能特性

- **匿名传话**：用户发消息给 Bot，转发给管理员（你）
- **双向回复**：管理员回复 Bot，消息原路传回给用户
- **多格式支持**：文字、图片、视频、文件、贴纸
- **无服务器**：部署到 Vercel，24小时在线，无需自建服务器
- **对话管理**：管理员可查看所有活跃对话
- **按钮操作**：一键回复，便捷操作

## 📸 界面预览

```
用户 → Bot → 管理员(你)
       ↑         ↓
用户 ← Bot ← 管理员(你)
```

## 🚀 快速部署

### 1. 获取 Telegram Bot Token
1. 在 Telegram 中搜索 @BotFather
2. 发送 `/newbot` 创建新机器人
3. 获取 **Bot Token**（形如 `123456:ABC-DEF1234ghIkl-z...`）

### 2. 获取你的用户 ID
1. 在 Telegram 中搜索 @userinfobot
2. 发送 `/start`
3. 获取 **Id**（一串数字）

### 3. 部署到 Vercel

**Vercel 一键部署**：
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/your-repo/tg-bot-forwarder)

或者手动部署：
```bash
npm i -g vercel
cd /var/minis/workspace/tg-bot-forwarder
vercel --prod
```

### 4. 配置环境变量
在 Vercel Project → Settings → Environment Variables：

| 变量 | 值 |
|------|-----|
| `TG_BOT_TOKEN` | 你的 Bot Token |
| `ADMIN_ID` | 你的用户 ID |
| `ECHO_MODE` | `true`（可选，自动回复用户） |

### 5. 设置 Webhook
替换以下链接中的 `<TOKEN>` 和 `<DOMAIN>`：
```bash
curl -X POST "https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook?url=https://<PROJECT>.vercel.app/"
```

## 🎯 使用方法

### 用户端
1. 搜索你的 Bot，开始对话
2. 发送任何消息（文字/图片/文件）
3. 收到回复

### 管理员端 (你)
1. **查看对话**：给 Bot 发送 `/list`
2. **回复用户**：
   - 方式1：点击消息下方的"↩️ 回复"按钮
   - 方式2：发送 `/reply_<用户ID> 你的消息`
   - 方式3：直接回复 Bot 转发的用户消息
3. **支持媒体**：发送图片/视频/文件给 Bot，会转发给用户

## ⚙️ 本地开发

```bash
# 克隆项目
git clone https://github.com/your-repo/tg-bot-forwarder

# 安装依赖
npm install

# 设置环境变量
cp .env.example .env
# 编辑 .env 文件

# 本地运行
npm run dev
```

## 📁 文件结构

```
├── api/index.js          # Bot 核心逻辑 (Vercel serverless)
├── package.json         # 依赖配置
├── vercel.json         # Vercel 部署配置
├── .env.example        # 环境变量模板
└── README.md
```

## ❓ 常见问题

**Q：如何获取用户 ID？**
A：使用 @userinfobot 获取，或者用户在对话时 Bot 会显示 ID。

**Q：Webhook 总是失败？**
A：检查域名 HTTPS、Vercel 是否部署成功、Bot Token 是否正确。

**Q：如何清空对话历史？**
A：重启 Bot（重启 Vercel 函数）或等待内存自然清理。

## 📄 License

MIT

## 🔗 相关资源
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api)
- [Vercel Serverless Functions](https://vercel.com/docs/functions)