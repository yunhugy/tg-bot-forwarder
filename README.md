> **云电脑 / 自有服务器部署版 → [`cloud`](../../tree/cloud) 分支**
>
> 不想用 Vercel 的话，`cloud` 分支提供了长轮询常驻版：不需要公网地址和域名，适合放在云电脑或自有服务器上长期在线。
> 相对本版的变化：本地文件持久化（用户资料、拉黑、待办关机不丢）、管理查询接口加鉴权（修复原 `?stats=1` 公开可查问题）、15 分钟保活、新增待办管理（`/pending`、`/done <ID>`、`/reopen <ID>`）、裸命令用法提示。
> 下文为 Vercel serverless 版说明（`main` 分支）。

---

# Telegram 匿名双向传话 Bot（Vercel）

用户私聊 Bot → 转发给管理员（你）→ 你回复后原路回传给用户。  
支持文本、图片、视频、文件、音频、语音、贴纸。

## 当前可用配置（本项目）

- Bot：`@markgetbot`
- 管理员 ID：`6609386680`
- 部署平台：Vercel Serverless
- Webhook 路径：`/api/index.js`

---

## 环境变量

| 变量 | 说明 |
|---|---|
| `TG_BOT_TOKEN` | BotFather 提供的 Token（不要带 `bot` 前缀） |
| `ADMIN_ID` | 管理员用户 ID（本项目为 `6609386680`） |
| `ECHO_MODE` | `true/false`，用户发消息后是否自动回执 |

---

## 一次性初始化 Webhook（重要）

部署后，打开：

`https://你的域名/api/index.js?setup=1`

返回 `"Webhook was set"` 即成功。

> 本项目已内置 setup 逻辑，会自动把 webhook 绑定到正确路径 `/api/index.js`。

---

## 使用方法

### 用户侧
直接给 Bot 发消息即可。

### 管理员侧

- `/start` 或 `/help`：查看管理员用法
- `/id`：查看管理员 ID
- `/reply_<用户ID> 内容`：指定回复用户
- 或直接回复“Bot 转发来的那条用户消息”

---

## 功能说明

### 1) 用户 -> 管理员
- 用户发文本/媒体给 Bot
- Bot 转发给管理员，并附带 `[UID:xxx]`

### 2) 管理员 -> 用户
- 管理员回复转发消息（或 `/reply_xxx`）
- Bot 原路转发回对应用户

### 3) 媒体支持
- 文本
- 图片（photo）
- 视频（video）
- 文件（document）
- 音频（audio）
- 语音（voice）
- 贴纸（sticker）

---

## 故障排查（最常见）

### A. setup 返回 401 Unauthorized
`TG_BOT_TOKEN` 无效或格式错误。请重新粘贴 BotFather token。

### B. 发消息不回
1. 先访问 `.../api/index.js?setup=1` 重新绑 webhook
2. 确认返回 `ok: true`
3. 再发 `test`

### C. 管理员发消息没反应
管理员消息需要：
- 回复某条用户转发消息，或
- 使用 `/reply_用户ID 内容`

---

## 项目结构

```text
api/index.js     # 主逻辑（生产）
vercel.json      # Vercel 路由
package.json     # 项目配置
README.md        # 本文档
```
