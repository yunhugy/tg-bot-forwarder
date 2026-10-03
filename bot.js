#!/usr/bin/env node
// bot.js — 云电脑常驻版入口：Telegram getUpdates 长轮询 + 本地管理 HTTP 接口。
//
// 与 Vercel 版的区别：
// - 不再依赖 webhook / 公网地址，纯出站 HTTPS 轮询即可工作
// - 状态持久化到本地 data/state.json（用户资料、拉黑、当前对话对象、offset）
// - /stats、/user 管理接口只监听 127.0.0.1 且必须带 HTTP_TOKEN 鉴权
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileStore } from './lib/store.js';
import { createRelay } from './lib/relay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const BOT = (env.TG_BOT_TOKEN || '').trim().replace(/^bot/i, '');
if (!BOT) {
  console.error('[bot] TG_BOT_TOKEN 未设置，退出。请复制 .env.example 为 .env 并填写。');
  process.exit(1);
}

const config = {
  adminId: Number(env.ADMIN_ID || '6609386680'),
  echoMode: env.ECHO_MODE !== 'false',
  github: env.GITHUB_TOKEN
    ? {
        token: env.GITHUB_TOKEN,
        owner: env.GITHUB_OWNER || 'yunhugy',
        repo: env.GITHUB_REPO || 'tg-bot-forwarder',
        bansPath: env.GITHUB_BANS_PATH || 'bans.json',
      }
    : null,
  dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
  httpPort: Number(env.HTTP_PORT || '8787'),
  httpToken: env.HTTP_TOKEN || '',
  dropPending: env.DROP_PENDING !== 'false',
  pollTimeout: Math.min(50, Math.max(5, Number(env.POLL_TIMEOUT || '50'))),
};

const tg = async (method, body = {}) => {
  const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let d;
  try {
    d = await r.json();
  } catch {
    throw new Error(`Telegram API ${method}: HTTP ${r.status} (非 JSON 响应)`);
  }
  if (!d.ok) {
    const err = new Error(`Telegram API ${method} 失败: ${d.description || r.status}`);
    err.code = d.error_code;
    err.tg = d;
    throw err;
  }
  return d.result;
};

const store = createFileStore(config.dataDir);
await store.load();
const relay = createRelay({ config, store, tg });

// ---------- 本地管理 HTTP（仅 127.0.0.1，需 HTTP_TOKEN） ----------
function tokenOk(provided) {
  if (!config.httpToken) return false;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(config.httpToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const send = (code, obj) => {
    res.writeHead(code);
    res.end(JSON.stringify(obj));
  };
  let u;
  try {
    u = new URL(req.url || '/', 'http://localhost');
  } catch {
    return send(400, { ok: false, error: 'bad url' });
  }

  if (u.pathname === '/health') {
    return send(200, { ok: true, mode: 'polling', users: store.getAllUsers().length });
  }

  if (!tokenOk(u.searchParams.get('token'))) {
    return send(403, { ok: false, error: 'forbidden: 需要正确的 token 参数（在 .env 里设置 HTTP_TOKEN）' });
  }
  try {
    if (u.pathname === '/stats') return send(200, await relay.getStats());
    if (u.pathname === '/user') return send(200, await relay.getUserInfo(u.searchParams.get('uid')));
    return send(404, { ok: false, error: 'unknown endpoint' });
  } catch (e) {
    return send(500, { ok: false, error: e.message });
  }
});

server.listen(config.httpPort, '127.0.0.1', () => {
  console.log(`[bot] 管理接口监听 127.0.0.1:${config.httpPort}（需 HTTP_TOKEN）`);
});

// ---------- 轮询主循环 ----------
let running = true;
let offset = store.getOffset();

async function pollOnce() {
  const updates = await tg('getUpdates', {
    offset,
    timeout: config.pollTimeout,
    allowed_updates: ['message'],
  });
  for (const update of updates) {
    offset = update.update_id + 1;
    store.setOffset(offset);
    const m = update.message;
    if (m) {
      const kind = m.text ? 'text' : m.photo ? 'photo' : m.video ? 'video' : m.document ? 'document' : m.audio ? 'audio' : m.voice ? 'voice' : m.sticker ? 'sticker' : 'other';
      console.log(`[bot] update ${update.update_id}: from=${m.from?.id} kind=${kind}`);
    }
    try {
      await relay.handleUpdate(update);
    } catch (e) {
      console.error(`[bot] 处理 update ${update.update_id} 出错:`, e.message);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function shutdown(signal) {
  if (!running) return;
  running = false;
  console.log(`[bot] 收到 ${signal}，正在保存状态并退出…`);
  try {
    await store.flush();
  } catch (e) {
    console.error('[bot] 保存状态失败:', e.message);
  }
  server.close();
  // 给未完成的请求一点时间
  setTimeout(() => process.exit(0), 800).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  const me = await tg('getMe');
  console.log(`[bot] 已连接 Bot @${me.username} (id=${me.id})`);

  // 轮询模式必须先删 webhook，否则 getUpdates 拿不到消息
  try {
    const wh = await tg('deleteWebhook', { drop_pending_updates: config.dropPending });
    console.log(`[bot] 已删除 webhook，切到轮询模式${config.dropPending ? '（丢弃切换前的积压消息）' : ''}`);
  } catch (e) {
    console.error('[bot] deleteWebhook 失败:', e.message, '——可能 Vercel 端仍在接收消息');
  }

  console.log('[bot] 开始轮询…');
  let backoff = 1000;
  while (running) {
    try {
      await pollOnce();
      backoff = 1000; // 成功后重置退避
    } catch (e) {
      if (e.code === 401) {
        console.error('[bot] TG_BOT_TOKEN 无效 (401)，退出。请检查 token。');
        process.exit(2);
      }
      if (e.code === 409) {
        console.error('[bot] 409 冲突：可能 webhook 未删除或另一个实例在轮询，10 秒后重试…');
        await sleep(10000);
        continue;
      }
      console.error(`[bot] 轮询出错: ${e.message}，${backoff / 1000}s 后重试…`);
      await sleep(backoff);
      backoff = Math.min(60000, backoff * 2);
    }
  }
}

main().catch((e) => {
  console.error('[bot] 启动失败:', e.message);
  process.exit(1);
});
