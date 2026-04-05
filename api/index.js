export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const token = (process.env.TG_BOT_TOKEN || '').trim().replace(/^bot/i, '');
  const ADMIN_ID = Number(process.env.ADMIN_ID || '6609386680');
  const ECHO_MODE = process.env.ECHO_MODE !== 'false';
  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

  if (!token) return res.status(500).json({ ok: false, error: 'TG_BOT_TOKEN not set' });

  const api = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json());

  // -------- storage layer --------
  const mem = globalThis.__relay_mem || (globalThis.__relay_mem = {
    users: {}, recent: []
  });

  const hasRedis = !!(REDIS_URL && REDIS_TOKEN);
  const redis = async (cmd, ...args) => {
    const r = await fetch(`${REDIS_URL}/${cmd}/${args.map(v => encodeURIComponent(String(v))).join('/')}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    return r.json();
  };

  async function getUser(uid) {
    if (hasRedis) {
      const r = await redis('GET', `relay:user:${uid}`);
      return r.result ? JSON.parse(r.result) : null;
    }
    return mem.users[uid] || null;
  }

  async function saveUser(uid, data) {
    if (hasRedis) {
      await redis('SET', `relay:user:${uid}`, JSON.stringify(data));
      await redis('ZADD', 'relay:recent', Date.now(), uid);
      return;
    }
    mem.users[uid] = data;
    mem.recent = [uid, ...mem.recent.filter(x => String(x) !== String(uid))].slice(0, 50);
  }

  async function listRecentUsers(limit = 10) {
    if (hasRedis) {
      const r = await redis('ZREVRANGE', 'relay:recent', 0, limit - 1);
      const ids = r.result || [];
      const out = [];
      for (const uid of ids) {
        const u = await getUser(uid);
        if (u) out.push(u);
      }
      return out;
    }
    return mem.recent.slice(0, limit).map(uid => mem.users[uid]).filter(Boolean);
  }

  function displayName(user) {
    return [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || '匿名用户';
  }

  function profileTitle(profile) {
    const nick = profile.nickname || '匿名用户';
    const uname = profile.username ? ` @${profile.username}` : '';
    const tags = profile.tags?.length ? ` [${profile.tags.join(', ')}]` : '';
    const note = profile.note ? ` (${profile.note})` : '';
    return `${nick}${uname}${tags}${note}`;
  }

  async function ensureProfile(from) {
    const uid = Number(from.id);
    const existing = await getUser(uid);
    const profile = {
      id: uid,
      nickname: displayName(from),
      username: from.username || '',
      first_name: from.first_name || '',
      last_name: from.last_name || '',
      banned: existing?.banned || false,
      tags: existing?.tags || [],
      note: existing?.note || '',
      created_at: existing?.created_at || Date.now(),
      last_seen_at: Date.now(),
      last_message_preview: existing?.last_message_preview || '',
      message_count: (existing?.message_count || 0),
    };
    await saveUser(uid, profile);
    return profile;
  }

  async function updateProfileMessage(uid, preview) {
    const p = await getUser(uid);
    if (!p) return null;
    p.last_seen_at = Date.now();
    p.last_message_preview = preview || p.last_message_preview || '';
    p.message_count = (p.message_count || 0) + 1;
    await saveUser(uid, p);
    return p;
  }

  async function setBan(uid, banned) {
    const p = await getUser(uid);
    if (!p) return null;
    p.banned = banned;
    await saveUser(uid, p);
    return p;
  }

  async function setNote(uid, note) {
    const p = await getUser(uid);
    if (!p) return null;
    p.note = note;
    await saveUser(uid, p);
    return p;
  }

  async function addTag(uid, tag) {
    const p = await getUser(uid);
    if (!p) return null;
    const t = String(tag).trim();
    if (t && !p.tags.includes(t)) p.tags.push(t);
    await saveUser(uid, p);
    return p;
  }

  async function removeTag(uid, tag) {
    const p = await getUser(uid);
    if (!p) return null;
    p.tags = (p.tags || []).filter(x => x !== tag);
    await saveUser(uid, p);
    return p;
  }

  async function getCurrentTarget() {
    if (hasRedis) {
      const r = await redis('GET', 'relay:admin:current_target');
      return r.result ? Number(r.result) : null;
    }
    return mem.currentTarget || null;
  }

  async function setCurrentTarget(uid) {
    if (hasRedis) {
      await redis('SET', 'relay:admin:current_target', uid);
      return;
    }
    mem.currentTarget = Number(uid);
  }

  // -------- GET / setup --------
  if (req.method === 'GET') {
    const setup = req.query?.setup === '1' || String(req.url || '').includes('setup=1');
    if (setup) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const hook = `${proto}://${host}/api/index.js`;
      const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ url: hook }).toString(),
      });
      const j = await r.json();
      return res.status(200).json({ ok: true, mode: 'setup', webhook: hook, telegram: j, storage: hasRedis ? 'redis' : 'memory' });
    }
    return res.status(200).json({ ok: true, mode: 'relay', storage: hasRedis ? 'redis' : 'memory' });
  }

  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  try {
    const update = req.body || {};
    const msg = update.message;
    const cb = update.callback_query;

    if (cb) {
      await api('answerCallbackQuery', { callback_query_id: cb.id });
      return res.status(200).json({ ok: true });
    }
    if (!msg || !msg.chat || !msg.from) return res.status(200).json({ ok: true });

    const fromId = Number(msg.from.id);

    // ---------- admin side ----------
    if (fromId === ADMIN_ID) {
      if (msg.text === '/start' || msg.text === '/help') {
        await api('sendMessage', {
          chat_id: ADMIN_ID,
          text: '管理员命令：\n/start - 帮助\n/help - 帮助\n/id - 管理员ID\n/status - 机器人状态\n/users - 最近用户\n/reply - 回复说明\n/user_<ID> - 查看用户资料\n/ban_<ID> - 拉黑用户\n/unban_<ID> - 取消拉黑\n/note_<ID> 备注 - 设置备注\n/tag_<ID> 标签 - 添加标签\n/untag_<ID> 标签 - 移除标签',
        });
        return res.status(200).json({ ok: true });
      }

      if (msg.text === '/id') {
        await api('sendMessage', { chat_id: ADMIN_ID, text: `你的 ADMIN_ID: ${ADMIN_ID}` });
        return res.status(200).json({ ok: true });
      }

      if (msg.text === '/status') {
        await api('sendMessage', {
          chat_id: ADMIN_ID,
          text: `状态：\n- Bot: 正常运行\n- 管理员ID: ${ADMIN_ID}\n- 自动回执: ${ECHO_MODE ? '开启' : '关闭'}\n- 存储: ${hasRedis ? 'Redis 持久化' : '内存临时模式'}\n- 部署: Vercel`,
        });
        return res.status(200).json({ ok: true });
      }

      if (msg.text === '/reply') {
        await api('sendMessage', {
          chat_id: ADMIN_ID,
          text: '回复用户方法：\n1. 用户一旦发来消息，系统会自动把“当前回复对象”切到该用户\n2. 你直接在对话框输入内容即可回给当前对象\n3. /current 查看当前回复对象\n4. /to_<用户ID> 仅作为手动切换备用\n5. /reply_<用户ID> 内容 也可继续使用',
        });
        return res.status(200).json({ ok: true });
      }

      if (msg.text === '/current') {
        const current = await getCurrentTarget();
        if (!current) {
          await api('sendMessage', { chat_id: ADMIN_ID, text: '当前没有选中的回复对象' });
        } else {
          const u = await getUser(current);
          await api('sendMessage', { chat_id: ADMIN_ID, text: u ? `当前回复对象：${u.username ? '@'+u.username : u.nickname} (${u.id})` : `当前回复对象：${current}` });
        }
        return res.status(200).json({ ok: true });
      }

      const toCmd = (msg.text || '').match(/^\/to_(\d+)$/);
      if (toCmd) {
        const uid = Number(toCmd[1]);
        const u = await getUser(uid);
        await setCurrentTarget(uid);
        await api('sendMessage', {
          chat_id: ADMIN_ID,
          text: u ? `已切换当前回复对象：${u.username ? '@'+u.username : u.nickname} (${u.id})\n现在直接输入内容就会发给他。` : `已切换当前回复对象：${uid}`,
        });
        return res.status(200).json({ ok: true });
      }

      if (msg.text === '/users') {
        const users = await listRecentUsers(15);
        if (!users.length) {
          await api('sendMessage', { chat_id: ADMIN_ID, text: '暂无用户记录' });
          return res.status(200).json({ ok: true });
        }
        const lines = users.map((u, i) => {
          const name = u.username ? `@${u.username}` : u.nickname;
          const banned = u.banned ? ' 🚫' : '';
          const tags = u.tags?.length ? ` [${u.tags.join(', ')}]` : '';
          return `${i + 1}. ${name}${banned}${tags}\nID: ${u.id}\n最近: ${u.last_message_preview || '-'}\n`;
        });
        await api('sendMessage', { chat_id: ADMIN_ID, text: lines.join('\n') });
        return res.status(200).json({ ok: true });
      }

      const userCmd = (msg.text || '').match(/^\/user_(\d+)$/);
      if (userCmd) {
        const uid = Number(userCmd[1]);
        const u = await getUser(uid);
        await api('sendMessage', {
          chat_id: ADMIN_ID,
          text: u ? `用户资料\n姓名: ${u.nickname}\n用户名: ${u.username || '-'}\nID: ${u.id}\n标签: ${(u.tags || []).join(', ') || '-'}\n备注: ${u.note || '-'}\n状态: ${u.banned ? '已拉黑' : '正常'}\n消息数: ${u.message_count || 0}\n最后消息: ${u.last_message_preview || '-'}\n最后活跃: ${u.last_seen_at ? new Date(u.last_seen_at).toLocaleString('zh-CN') : '-'}` : '用户不存在',
        });
        return res.status(200).json({ ok: true });
      }

      const banCmd = (msg.text || '').match(/^\/ban_(\d+)$/);
      if (banCmd) {
        const u = await setBan(Number(banCmd[1]), true);
        await api('sendMessage', { chat_id: ADMIN_ID, text: u ? `已拉黑 ${u.id}` : '用户不存在' });
        return res.status(200).json({ ok: true });
      }
      const unbanCmd = (msg.text || '').match(/^\/unban_(\d+)$/);
      if (unbanCmd) {
        const u = await setBan(Number(unbanCmd[1]), false);
        await api('sendMessage', { chat_id: ADMIN_ID, text: u ? `已取消拉黑 ${u.id}` : '用户不存在' });
        return res.status(200).json({ ok: true });
      }
      const noteCmd = (msg.text || '').match(/^\/note_(\d+)\s+([\s\S]+)$/);
      if (noteCmd) {
        const u = await setNote(Number(noteCmd[1]), noteCmd[2]);
        await api('sendMessage', { chat_id: ADMIN_ID, text: u ? `已设置备注：${u.note}` : '用户不存在' });
        return res.status(200).json({ ok: true });
      }
      const tagCmd = (msg.text || '').match(/^\/tag_(\d+)\s+(.+)$/);
      if (tagCmd) {
        const u = await addTag(Number(tagCmd[1]), tagCmd[2]);
        await api('sendMessage', { chat_id: ADMIN_ID, text: u ? `已添加标签：${tagCmd[2]}` : '用户不存在' });
        return res.status(200).json({ ok: true });
      }
      const untagCmd = (msg.text || '').match(/^\/untag_(\d+)\s+(.+)$/);
      if (untagCmd) {
        const u = await removeTag(Number(untagCmd[1]), untagCmd[2]);
        await api('sendMessage', { chat_id: ADMIN_ID, text: u ? `已移除标签：${untagCmd[2]}` : '用户不存在' });
        return res.status(200).json({ ok: true });
      }

      let targetUid = null;
      const replyCmd = (msg.text || '').match(/^\/reply_(\d+)\s+([\s\S]+)/);
      if (replyCmd) targetUid = Number(replyCmd[1]);
      if (!targetUid && msg.reply_to_message) {
        const src = msg.reply_to_message.text || msg.reply_to_message.caption || '';
        const m = src.match(/\[UID:(\d+)\]/);
        if (m) targetUid = Number(m[1]);
      }
      if (!targetUid) {
        targetUid = await getCurrentTarget();
      }
      if (!targetUid) {
        await api('sendMessage', {
          chat_id: ADMIN_ID,
          text: '当前没有可回复的用户。\n请先等用户发来一条消息，系统会自动切换到该用户；或者手动使用 /to_<用户ID>。',
        });
        return res.status(200).json({ ok: true });
      }

      if (msg.text && replyCmd) {
        await api('sendMessage', { chat_id: targetUid, text: replyCmd[2] });
        await api('sendMessage', { chat_id: ADMIN_ID, text: `✅ 已发送给 ${targetUid}` });
        return res.status(200).json({ ok: true });
      }

      if (msg.text) {
        await api('sendMessage', { chat_id: targetUid, text: msg.text });
        await api('sendMessage', { chat_id: ADMIN_ID, text: `✅ 已发送给 ${targetUid}` });
      } else if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await api('sendPhoto', { chat_id: targetUid, photo: fileId, caption: msg.caption || '' });
        await api('sendMessage', { chat_id: ADMIN_ID, text: `✅ 图片已发送给 ${targetUid}` });
      } else if (msg.video) {
        await api('sendVideo', { chat_id: targetUid, video: msg.video.file_id, caption: msg.caption || '' });
        await api('sendMessage', { chat_id: ADMIN_ID, text: `✅ 视频已发送给 ${targetUid}` });
      } else if (msg.document) {
        await api('sendDocument', { chat_id: targetUid, document: msg.document.file_id, caption: msg.caption || '' });
        await api('sendMessage', { chat_id: ADMIN_ID, text: `✅ 文件已发送给 ${targetUid}` });
      } else if (msg.audio) {
        await api('sendAudio', { chat_id: targetUid, audio: msg.audio.file_id, caption: msg.caption || '' });
        await api('sendMessage', { chat_id: ADMIN_ID, text: `✅ 音频已发送给 ${targetUid}` });
      } else if (msg.voice) {
        await api('sendVoice', { chat_id: targetUid, voice: msg.voice.file_id, caption: msg.caption || '' });
        await api('sendMessage', { chat_id: ADMIN_ID, text: `✅ 语音已发送给 ${targetUid}` });
      } else if (msg.sticker) {
        await api('sendSticker', { chat_id: targetUid, sticker: msg.sticker.file_id });
        await api('sendMessage', { chat_id: ADMIN_ID, text: `✅ 贴纸已发送给 ${targetUid}` });
      }
      return res.status(200).json({ ok: true });
    }

    // ---------- user side ----------
    let profile = await ensureProfile(msg.from);
    profile = await updateProfileMessage(fromId, msg.text || msg.caption || (msg.photo ? '[图片]' : msg.video ? '[视频]' : msg.document ? '[文件]' : msg.voice ? '[语音]' : msg.audio ? '[音频]' : msg.sticker ? '[贴纸]' : '[消息]'));
    await setCurrentTarget(fromId);

    if (profile?.banned) {
      return res.status(200).json({ ok: true, blocked: true });
    }

    const title = profile.username ? `@${profile.username}` : profile.nickname;
    const hiddenTagHtml = `<tg-spoiler>[UID:${fromId}]</tg-spoiler>`;

    if (msg.text) {
      await api('sendMessage', {
        chat_id: ADMIN_ID,
        text: `<b>${title}</b>\n${msg.text}\n\n${hiddenTagHtml}`,
        parse_mode: 'HTML'
      });
    } else if (msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      await api('sendPhoto', {
        chat_id: ADMIN_ID,
        photo: fileId,
        caption: `<b>${title}</b>\n${msg.caption || ''}\n\n${hiddenTagHtml}`,
        parse_mode: 'HTML'
      });
    } else if (msg.video) {
      await api('sendVideo', {
        chat_id: ADMIN_ID,
        video: msg.video.file_id,
        caption: `<b>${title}</b>\n${msg.caption || ''}\n\n${hiddenTagHtml}`,
        parse_mode: 'HTML'
      });
    } else if (msg.document) {
      await api('sendDocument', {
        chat_id: ADMIN_ID,
        document: msg.document.file_id,
        caption: `<b>${title}</b>\n${msg.caption || ''}\n\n${hiddenTagHtml}`,
        parse_mode: 'HTML'
      });
    } else if (msg.audio) {
      await api('sendAudio', {
        chat_id: ADMIN_ID,
        audio: msg.audio.file_id,
        caption: `<b>${title}</b>\n${msg.caption || ''}\n\n${hiddenTagHtml}`,
        parse_mode: 'HTML'
      });
    } else if (msg.voice) {
      await api('sendVoice', { chat_id: ADMIN_ID, voice: msg.voice.file_id });
      await api('sendMessage', {
        chat_id: ADMIN_ID,
        text: `<b>${title}</b>\n[语音消息]\n\n${hiddenTagHtml}`,
        parse_mode: 'HTML'
      });
    } else if (msg.sticker) {
      await api('sendSticker', { chat_id: ADMIN_ID, sticker: msg.sticker.file_id });
      await api('sendMessage', {
        chat_id: ADMIN_ID,
        text: `<b>${title}</b>\n[贴纸]\n\n${hiddenTagHtml}`,
        parse_mode: 'HTML'
      });
    }

    if (ECHO_MODE && !((msg.text || '').startsWith('/'))) {
      await api('sendMessage', { chat_id: msg.chat.id, text: '✅ 已收到' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.log('relay_error', e?.message || String(e));
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
