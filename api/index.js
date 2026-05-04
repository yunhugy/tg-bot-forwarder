export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const BOT = (process.env.TG_BOT_TOKEN || '').trim().replace(/^bot/i, '');
  const ADMIN_ID = Number(process.env.ADMIN_ID || '6609386680');
  const ECHO_MODE = process.env.ECHO_MODE !== 'false';

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

  const GH_TOKEN = process.env.GITHUB_TOKEN || '';
  const GH_OWNER = process.env.GITHUB_OWNER || 'yunhugy';
  const GH_REPO = process.env.GITHUB_REPO || 'tg-bot-forwarder';
  const GH_BANS_PATH = process.env.GITHUB_BANS_PATH || 'bans.json';

  if (!BOT) return res.status(500).json({ ok: false, error: 'TG_BOT_TOKEN missing' });

  const hasRedis = !!(REDIS_URL && REDIS_TOKEN);
  const hasGithubStore = !!GH_TOKEN;

  const mem = globalThis.__relay_mem || (globalThis.__relay_mem = { users: {}, recent: [], hardBans: {}, currentTarget: null });

  const tg = (method, body) => fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }).then(r => r.json());

  const redis = async (cmd, ...args) => {
    const url = `${REDIS_URL}/${cmd}/${args.map(a => encodeURIComponent(String(a))).join('/')}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    return r.json();
  };

  async function ghGetBans() {
    if (!hasGithubStore) return { map: {}, sha: null };
    const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(GH_BANS_PATH)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'markgetbot' } });
    if (r.status === 404) return { map: {}, sha: null };
    const d = await r.json();
    const txt = Buffer.from(d.content || '', 'base64').toString('utf8') || '{}';
    let map = {};
    try { map = JSON.parse(txt); } catch { map = {}; }
    return { map, sha: d.sha || null };
  }

  async function ghPutBans(map, sha) {
    if (!hasGithubStore) return false;
    const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(GH_BANS_PATH)}`;
    const body = {
      message: 'chore: update bans.json by bot',
      content: Buffer.from(JSON.stringify(map, null, 2), 'utf8').toString('base64'),
      branch: 'main'
    };
    if (sha) body.sha = sha;
    const r = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'markgetbot' },
      body: JSON.stringify(body)
    });
    return r.ok;
  }

  function profileTitle(u) { return u?.username ? `@${u.username}` : (u?.nickname || `用户${u?.id || ''}`); }

  async function getUser(uid) {
    if (hasRedis) {
      const r = await redis('GET', `relay:user:${uid}`);
      return r.result ? JSON.parse(r.result) : null;
    }
    return mem.users[String(uid)] || null;
  }

  async function saveUser(uid, data) {
    const key = String(uid);
    if (hasRedis) {
      await redis('SET', `relay:user:${key}`, JSON.stringify(data));
      await redis('ZADD', 'relay:recent', Date.now(), key);
      return;
    }
    mem.users[key] = data;
    mem.recent = [key, ...mem.recent.filter(x => x !== key)].slice(0, 300);
  }

  async function listRecentUsers(limit = 20) {
    if (hasRedis) {
      const r = await redis('ZREVRANGE', 'relay:recent', 0, Math.max(0, limit - 1));
      const ids = r.result || [];
      const out = [];
      for (const id of ids) { const u = await getUser(id); if (u) out.push(u); }
      return out;
    }
    return mem.recent.slice(0, limit).map(id => mem.users[id]).filter(Boolean);
  }

  async function ensureProfile(from) {
    const uid = Number(from.id);
    const old = await getUser(uid);
    const p = old || {
      id: uid, username: from.username || '', first_name: from.first_name || '', last_name: from.last_name || '',
      nickname: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || `用户${uid}`,
      banned: false, tags: [], note: '', created_at: Date.now(), last_seen_at: Date.now(), last_message_preview: '', message_count: 0
    };
    p.username = from.username || p.username || '';
    p.first_name = from.first_name || p.first_name || '';
    p.last_name = from.last_name || p.last_name || '';
    p.nickname = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || p.nickname;
    p.last_seen_at = Date.now();
    await saveUser(uid, p);
    return p;
  }

  async function updateProfileMessage(uid, preview) {
    const p = await getUser(uid); if (!p) return null;
    p.last_message_preview = String(preview || '').slice(0, 180);
    p.last_seen_at = Date.now();
    p.message_count = (p.message_count || 0) + 1;
    await saveUser(uid, p);
    return p;
  }

  async function setBan(uid, banned) {
    const u = Number(uid);
    const p = (await getUser(u)) || { id: u, nickname: `用户${u}`, username: '', first_name: '', last_name: '', banned: false, tags: [], note: '', created_at: Date.now(), last_seen_at: Date.now(), last_message_preview: '', message_count: 0 };
    p.banned = !!banned;
    await saveUser(u, p);
    mem.hardBans[String(u)] = !!banned;
    if (hasGithubStore) {
      const { map, sha } = await ghGetBans();
      map[String(u)] = !!banned;
      await ghPutBans(map, sha);
    }
    return p;
  }

  async function isBanned(uid) {
    const u = await getUser(uid);
    if (u?.banned) return true;
    if (mem.hardBans[String(uid)]) return true;
    if (hasGithubStore) {
      const { map } = await ghGetBans();
      if (map[String(uid)] === true) return true;
    }
    return false;
  }

  async function setCurrentTarget(uid) {
    if (hasRedis) { await redis('SET', 'relay:admin:current_target', uid); return; }
    mem.currentTarget = Number(uid);
  }

  async function getCurrentTarget() {
    if (hasRedis) {
      const r = await redis('GET', 'relay:admin:current_target');
      return r.result ? Number(r.result) : null;
    }
    return mem.currentTarget || null;
  }

  function detectAdSpam(text = '') {
    const raw = String(text || ''); if (!raw.trim()) return { hit: false, reason: '' };
    let score = 0; const hits = []; const add = (ok,s,n)=>{ if(ok){score+=s;hits.push(n);} };
    add(/(t\.me\/|telegram\.me\/|tg\s*[:：]?\s*@|频道[:：]?\s*@|群[:：]?\s*@|私聊[:：]?\s*@)/i.test(raw), 5, 'TG引流');
    add(/@[a-zA-Z0-9_]{4,}/.test(raw), 2, '@账号');
    add(/(https?:\/\/|www\.)/i.test(raw), 3, '外链');
    add(/(群发|引流|推广|广告|渠道|频道|加群|拉群|进群|私聊|联系)/i.test(raw), 2, '推广语义');
    add(/(自动处理验证|自动验证|批量分发|代发|推广系统|脚本群发|机器人群发)/i.test(raw), 4, '自动化群发');
    add(/(代理|返佣|分成|拉新|首充|送彩金|高返|稳赚|带单|导师|包赔|包赚)/i.test(raw), 4, '诈骗灰产');
    if (/@[a-zA-Z0-9_]{4,}/.test(raw) && /(群发|批量分发|自动处理验证|推广|引流)/i.test(raw)) { score += 6; hits.push('组合命中'); }
    return score >= 6 ? { hit: true, reason: hits.slice(0,3).join('+') } : { hit: false, reason: '' };
  }

  // GET utils
  if (req.method === 'GET') {
    const q = String(req.url || '');
    if (q.includes('setup=1')) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const hook = `${proto}://${host}/api/index.js`;
      const r = await fetch(`https://api.telegram.org/bot${BOT}/setWebhook`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ url: hook }).toString()
      });
      return res.status(200).json({ ok: true, webhook: hook, telegram: await r.json() });
    }

    const m = q.match(/[?&](?:check_uid|uid)=(\d+)/);
    if (m) {
      const uid = Number(m[1]);
      const user = await getUser(uid);
      return res.status(200).json({ ok: true, uid, found: !!user, user, storage: hasRedis ? 'redis' : (hasGithubStore ? 'github_bans+memory' : 'memory') });
    }

    if (q.includes('stats=1')) {
      const users = await listRecentUsers(500);
      const bannedUsers = [];
      for (const u of users) if (await isBanned(u.id)) bannedUsers.push({ id: u.id, username: u.username || '', nickname: u.nickname || '' });
      return res.status(200).json({ ok: true, storage: hasRedis ? 'redis' : (hasGithubStore ? 'github_bans+memory' : 'memory'), total_users: users.length, banned_count: bannedUsers.length, banned_users: bannedUsers.slice(0, 100) });
    }

    return res.status(200).json({ ok: true, mode: 'relay' });
  }

  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  try {
    const upd = req.body || {};
    const msg = upd.message;
    if (!msg || !msg.from || !msg.chat) return res.status(200).json({ ok: true });

    const fromId = Number(msg.from.id);

    // ADMIN
    if (fromId === ADMIN_ID) {
      const txt = String(msg.text || '');
      if (txt === '/start' || txt === '/help') {
        await tg('sendMessage', { chat_id: ADMIN_ID, text: '管理员命令:\n/users\n/current\n/to <ID>\n/ban <ID>\n/unban <ID>\n/reply <ID> 内容\n/status\n/id' });
        return res.status(200).json({ ok: true });
      }
      if (txt === '/id') { await tg('sendMessage', { chat_id: ADMIN_ID, text: `ADMIN_ID: ${ADMIN_ID}` }); return res.status(200).json({ ok: true }); }
      if (txt === '/status') { await tg('sendMessage', { chat_id: ADMIN_ID, text: `存储: ${hasRedis ? 'redis' : (hasGithubStore ? 'github_bans+memory' : 'memory')}` }); return res.status(200).json({ ok: true }); }
      if (txt === '/users') {
        const users = await listRecentUsers(20);
        if (!users.length) { await tg('sendMessage', { chat_id: ADMIN_ID, text: '暂无用户记录' }); return res.status(200).json({ ok: true }); }
        const lines = users.map((u, i) => `${i+1}. ${profileTitle(u)}\nID: ${u.id}\n最近: ${u.last_message_preview || '-'}`).join('\n\n');
        await tg('sendMessage', { chat_id: ADMIN_ID, text: lines });
        return res.status(200).json({ ok: true });
      }
      if (txt === '/current') {
        const cur = await getCurrentTarget();
        if (!cur) await tg('sendMessage', { chat_id: ADMIN_ID, text: '当前没有选中的回复对象' });
        else {
          const u = await getUser(cur);
          await tg('sendMessage', { chat_id: ADMIN_ID, text: `当前回复对象：${u ? profileTitle(u) : cur} (${cur})` });
        }
        return res.status(200).json({ ok: true });
      }

      const toCmd = txt.match(/^\/to(?:_|\s)+(\d+)$/);
      if (toCmd) { await setCurrentTarget(Number(toCmd[1])); await tg('sendMessage', { chat_id: ADMIN_ID, text: `已切换当前回复对象：${toCmd[1]}` }); return res.status(200).json({ ok: true }); }

      const banCmd = txt.match(/^\/ban(?:_|\s)+(\d+)$/);
      if (banCmd) { const u = await setBan(Number(banCmd[1]), true); await tg('sendMessage', { chat_id: ADMIN_ID, text: `已拉黑 ${u.id}` }); return res.status(200).json({ ok: true }); }

      const unbanCmd = txt.match(/^\/unban(?:_|\s)+(\d+)$/);
      if (unbanCmd) { const u = await setBan(Number(unbanCmd[1]), false); await tg('sendMessage', { chat_id: ADMIN_ID, text: `已取消拉黑 ${u.id}` }); return res.status(200).json({ ok: true }); }

      let targetUid = null;
      const replyCmd = txt.match(/^\/reply(?:_|\s)+(\d+)\s+([\s\S]+)/);
      if (replyCmd) targetUid = Number(replyCmd[1]);
      if (!targetUid && msg.reply_to_message) {
        const src = (msg.reply_to_message.text || msg.reply_to_message.caption || '');
        const m = src.match(/\[UID:(\d+)\]/); if (m) targetUid = Number(m[1]);
      }
      if (!targetUid) targetUid = await getCurrentTarget();
      if (!targetUid) { await tg('sendMessage', { chat_id: ADMIN_ID, text: '当前没有可回复用户，先等用户发消息或 /to <ID>' }); return res.status(200).json({ ok: true }); }

      if (msg.text && replyCmd) {
        await tg('sendMessage', { chat_id: targetUid, text: replyCmd[2] });
      } else if (msg.text) {
        await tg('sendMessage', { chat_id: targetUid, text: msg.text });
      } else if (msg.photo) {
        const f = msg.photo[msg.photo.length - 1].file_id;
        await tg('sendPhoto', { chat_id: targetUid, photo: f, caption: msg.caption || '' });
      } else if (msg.video) {
        await tg('sendVideo', { chat_id: targetUid, video: msg.video.file_id, caption: msg.caption || '' });
      } else if (msg.document) {
        await tg('sendDocument', { chat_id: targetUid, document: msg.document.file_id, caption: msg.caption || '' });
      } else if (msg.audio) {
        await tg('sendAudio', { chat_id: targetUid, audio: msg.audio.file_id, caption: msg.caption || '' });
      } else if (msg.voice) {
        await tg('sendVoice', { chat_id: targetUid, voice: msg.voice.file_id });
      } else if (msg.sticker) {
        await tg('sendSticker', { chat_id: targetUid, sticker: msg.sticker.file_id });
      }

      await tg('sendMessage', { chat_id: ADMIN_ID, text: `✅ 已发送给 ${targetUid}` });
      return res.status(200).json({ ok: true });
    }

    // USER incoming
    let p = await ensureProfile(msg.from);
    p = await updateProfileMessage(fromId, msg.text || msg.caption || '[媒体]');
    await setCurrentTarget(fromId);

    if (await isBanned(fromId)) return res.status(200).json({ ok: true, blocked: true });

    const content = msg.text || msg.caption || '';
    const hardSpam = /@[a-zA-Z0-9_]{4,}/.test(content) && /(群发|验证|频道|引流|推广|自动处理验证|批量分发)/i.test(content);
    const ad = hardSpam ? { hit: true, reason: '强规则:@账号+推广语义' } : detectAdSpam(content);
    if (ad.hit) {
      p = await setBan(fromId, true);
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `🚫 已自动拉黑疑似广告用户\n用户: ${profileTitle(p)}\nID: ${fromId}\n原因: ${ad.reason}\n内容: ${content.slice(0, 120) || '[非文本媒体]'}` });
      return res.status(200).json({ ok: true, auto_banned: true });
    }

    const title = profileTitle(p);
    const hiddenTagHtml = `<tg-spoiler>[UID:${fromId}]</tg-spoiler>`;

    if (msg.text) {
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `<b>${title}</b>\n${msg.text}\n\n${hiddenTagHtml}`, parse_mode: 'HTML' });
    } else if (msg.photo) {
      const f = msg.photo[msg.photo.length - 1].file_id;
      await tg('sendPhoto', { chat_id: ADMIN_ID, photo: f, caption: `<b>${title}</b>\n${msg.caption || ''}\n\n${hiddenTagHtml}`, parse_mode: 'HTML' });
    } else if (msg.video) {
      await tg('sendVideo', { chat_id: ADMIN_ID, video: msg.video.file_id, caption: `<b>${title}</b>\n${msg.caption || ''}\n\n${hiddenTagHtml}`, parse_mode: 'HTML' });
    } else if (msg.document) {
      await tg('sendDocument', { chat_id: ADMIN_ID, document: msg.document.file_id, caption: `<b>${title}</b>\n${msg.caption || ''}\n\n${hiddenTagHtml}`, parse_mode: 'HTML' });
    } else if (msg.audio) {
      await tg('sendAudio', { chat_id: ADMIN_ID, audio: msg.audio.file_id, caption: `<b>${title}</b>\n${msg.caption || ''}\n\n${hiddenTagHtml}`, parse_mode: 'HTML' });
    } else if (msg.voice) {
      await tg('sendVoice', { chat_id: ADMIN_ID, voice: msg.voice.file_id });
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `<b>${title}</b>\n[语音消息]\n\n${hiddenTagHtml}`, parse_mode: 'HTML' });
    } else if (msg.sticker) {
      await tg('sendSticker', { chat_id: ADMIN_ID, sticker: msg.sticker.file_id });
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `<b>${title}</b>\n[贴纸]\n\n${hiddenTagHtml}`, parse_mode: 'HTML' });
    }

    if (ECHO_MODE && !(msg.text || '').startsWith('/')) {
      await tg('sendMessage', { chat_id: msg.chat.id, text: '✅ 已收到。' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
