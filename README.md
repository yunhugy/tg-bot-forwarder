> 云电脑常驻版（`cloud` 分支）
>
> Vercel serverless 版在 [`main`](../../tree/main) 分支。
> 本分支 = main 的全部文件 + 云电脑部署新增文件。
> 云电脑版只需要：`bot.js`、`lib/`、`scripts/`、`test/`、`.env.example`（`tg-forwarder.service` 为可选 systemd 方案）；
> `api/`、`vercel.json`、`deploy.sh`、`upload_github.py`、`set_stateful_admin_commands.py`、`test_bot.py` 为 Vercel 版文件，云电脑版用不到。

---

# tg-bot-forwarder · 云电脑常驻版

从 Vercel serverless 版移植而来，改用 **Telegram 长轮询** 运行，不需要公网地址、不用 webhook，
适合跑在这台云电脑上长期在线。

## 改了什么（相对原版 `api/index.js`）

| 原版（Vercel） | 本版（云电脑） |
|---|---|
| webhook 接收消息，需公网 HTTPS | `getUpdates` 长轮询，纯出站 HTTPS |
| Upstash Redis / 内存（冷启动丢数据） | 本地 `data/state.json` 持久化（用户、拉黑、当前对话对象、offset） |
| `?stats=1` / `?uid=` 公开可查 | 只监听 `127.0.0.1`，必须带 `HTTP_TOKEN` 鉴权 |
| 每次消息都请求 GitHub 查拉黑名单 | GitHub 名单加 60 秒缓存 |
| serverless 单次执行 | 常驻进程，断线指数退避重连 |

业务逻辑（双向转发、管理员命令、备注/标签、反垃圾自动拉黑、ECHO 回执）与原版保持一致。

## 目录结构

```
bot.js              # 入口：轮询 + 本地管理 HTTP
lib/relay.js        # 核心业务逻辑（与环境解耦）
lib/store.js        # 文件持久化存储
data/state.json     # 运行时数据（自动生成）
.env                # 配置（自己从 .env.example 复制，chmod 600）
tg-forwarder.service# systemd 服务文件
test/mock-test.mjs  # 不联网的逻辑测试（19 项）
```

## 部署步骤

```bash
cd ~/workspace/tg-bot-forwarder

# 1. 复制配置并填写（至少填 TG_BOT_TOKEN、HTTP_TOKEN）
cp .env.example .env
chmod 600 .env
nano .env

# 2. 先手动跑一次验证
node bot.js
# 看到 "[bot] 开始轮询…" 后，给 Bot 发条消息测试，Ctrl+C 退出

# 3. 保活（已配置）
Bot 由平台定时任务 `tg-forwarder-healthcheck` 每 15 分钟检查一次：
- `scripts/healthcheck.sh`：调本地 `/health` 接口，不通则杀掉残留进程并拉起
- `scripts/boot.sh`：幂等启动（已在运行则退出），10 分钟内最多重启一次，日志进 `logs/bot.log`
- 定时任务是运行时托管的，整机替换后依然有效；`data/state.json` 在 `~/workspace` 下持久保存

```bash
# 手动检查 / 拉起
bash scripts/healthcheck.sh
curl http://127.0.0.1:8787/health

# 看日志
tail -f logs/bot.log

# 彻底停掉（含定时任务）
# 1. 在 Muse 里禁用/删除 tg-forwarder-healthcheck 定时任务
# 2. pkill -f "node $PWD/bot.js"
```

<details>
<summary>备选：systemd 服务（同一台机器内防崩溃，可选）</summary>

`tg-forwarder.service` 可装到 `/etc/systemd/system/`，`Restart=always`。
注意 `/etc` 在整机替换后会丢失，不能替代上面的定时任务保活。

```bash
sudo cp tg-forwarder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tg-forwarder
journalctl -u tg-forwarder -f
```
</details>
```

## 本地管理接口

```bash
# 健康检查（无需 token）
curl http://127.0.0.1:8787/health

# 统计（需要 token）
curl "http://127.0.0.1:8787/stats?token=你的HTTP_TOKEN"

# 查用户
curl "http://127.0.0.1:8787/user?uid=123456&token=你的HTTP_TOKEN"
```

## 从 Vercel 迁移的注意事项

- 启动时会自动调 `deleteWebhook` 把流量从 Vercel 接过来（同一时间只有一个端能收到消息）。
- `DROP_PENDING=true`（默认）会丢弃切换瞬间积压的旧消息，避免切过来后被旧消息轰炸；设为 `false` 则逐条补发。
- 如果 Vercel 那边还在跑，两边会抢消息——迁移完成后记得去 Vercel 把旧项目停掉或删掉。
- 想先验证再迁移：用 BotFather 新建一个测试 Bot 的 token 跑，确认没问题再换正式 token 重启服务。

## 测试

```bash
node test/mock-test.mjs   # 19 项全部通过才算正常
```
