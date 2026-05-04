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
    users: {}, recent: [], hardBans: {}
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
    const profile = p || {
      id: Number(uid),
      nickname: `用户${uid}`,
      username: '',
      first_name: '',
      last_name: '',
      banned: false,
      tags: [],
      note: '',
      created_at: Date.now(),
      last_seen_at: Date.now(),
      last_message_preview: '',
      message_count: 0,
    };
    profile.banned = banned;
    profile.last_seen_at = Date.now();
    await saveUser(uid, profile);
    // 内存硬拉黑（fallback场景）
    mem.hardBans[String(uid)] = !!banned;
    return profile;
  }

  async function isBanned(uid) {
    const u = await getUser(uid);
    if (u?.banned) return true;
    if (mem.hardBans[String(uid)]) return true;
    return false;
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

  function detectAdSpam(text = '') {
    const raw = String(text || '');
    const t = raw.toLowerCase();
    if (!t.trim()) return { hit: false, reason: '' };

    let score = 0;
    const hits = [];

    const add = (ok, s, name) => {
      if (ok) { score += s; hits.push(name); }
    };

    // 强特征
    add(/(t\.me\/|telegram\.me\/|tg\s*[:：]?\s*@|频道[:：]?\s*@|群[:：]?\s*@)/i.test(raw), 4, 'TG引流链接');
    add(/@[a-zA-Z0-9_]{4,}/.test(raw), 2, '@用户名');
    add(/(http[s]?:\/\/|www\.)/i.test(raw), 3, '外链');

    // 中特征
    add(/(群发|引流|推广|广告|频道|加群|拉群)/i.test(raw), 2, '推广词');
    add(/(验证|认证|自动处理验证|批量分发|代发|机器人分发)/i.test(raw), 2, '分发词');
    add(/(vx[:：]?|v信|微信|qq|whatsapp|line\s*id|联系我|加我)/i.test(raw), 2, '联系方式引导');
    add(/(博彩|带单|首充|返佣|代理招募|兼职赚钱|刷单|日结)/i.test(raw), 3, '灰产词');

    // 组合加权：有@用户名 + 推广词/验证词
    const hasAt = /@[a-zA-Z0-9_]{4,}/.test(raw);
    const hasPromo = /(群发|引流|推广|频道|验证|自动处理验证|批量分发)/i.test(raw);
    add(hasAt && hasPromo, 3, '组合命中');

    // 超长文案 + 标点堆叠
    add(raw.length > 120 && /[!！$￥#*]{3,}/.test(raw), 2, '刷屏样式');

    if (score >= 4) {
      return { hit: true, reason: hits.slice(0, 3).join('+') || '广告高风险' };
    }
    return { hit: false, reason: '' };
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
    const checkUidMatch = String(req.url || '').match(/[?&](?:check_uid|uid)=(\d+)/);
    if (checkUidMatch) {
      const uid = Number(checkUidMatch[1]);
      const u = await getUser(uid);
      return res.status(200).json({ ok: true, uid, found: !!u, user: u || null, storage: hasRedis ? 'redis' : 'memory' });
    }
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
          text: '管理员命令：\n/start - 帮助\n/help - 帮助\n/id - 管理员ID\n/status - 机器人状态\n/users - 最近用户\n/reply - 回复说明\n/user_<ID> - 查看用户资料\n/ban_<ID> - 拉黑用户\n/unban_<ID> - 取消拉黑\n/note_<ID> 备注 - 设置备注\n/tag_<ID> 标签 - 添加标签\n/untag_<ID> 标签 - 移除标签\n\n已启用：广告关键词自动拉黑（命中后自动封禁并通知管理员）',
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

      const toCmd = (msg.text || '').match(/^\/to(?:_|\s)+(\d+)$/);
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

      const userCmd = (msg.text || '').match(/^\/user(?:_|\s)+(\d+)$/);
      if (userCmd) {
        const uid = Number(userCmd[1]);
        const u = await getUser(uid);
        await api('sendMessage', {
          chat_id: ADMIN_ID,
          text: u ? `用户资料\n姓名: ${u.nickname}\n用户名: ${u.username || '-'}\nID: ${u.id}\n标签: ${(u.tags || []).join(', ') || '-'}\n备注: ${u.note || '-'}\n状态: ${u.banned ? '已拉黑' : '正常'}\n消息数: ${u.message_count || 0}\n最后消息: ${u.last_message_preview || '-'}\n最后活跃: ${u.last_seen_at ? new Date(u.last_seen_at).toLocaleString('zh-CN') : '-'}` : '用户不存在',
        });
        return res.status(200).json({ ok: true });
      }

      const banCmd = (msg.text || '').match(/^\/ban(?:_|\s)+(\d+)$/);
      if (banCmd) {
        const u = await setBan(Number(banCmd[1]), true);
        await api('sendMessage', { chat_id: ADMIN_ID, text: u ? `已拉黑 ${u.id}` : '用户不存在' });
        return res.status(200).json({ ok: true });
      }
      const unbanCmd = (msg.text || '').match(/^\/unban(?:_|\s)+(\d+)$/);
      if (unbanCmd) {
        const u = await setBan(Number(unbanCmd[1]), false);
        await api('sendMessage', { chat_id: ADMIN_ID, text: u ? `已取消拉黑 ${u.id}` : '用户不存在' });
        return res.status(200).json({ ok: true });
      }
      const noteCmd = (msg.text || '').match(/^\/note(?:_|\s)+(\d+)\s+([\s\S]+)$/);
      if (noteCmd) {
        const u = await setNote(Number(noteCmd[1]), noteCmd[2]);
        await api('sendMessage', { chat_id: ADMIN_ID, text: u ? `已设置备注：${u.note}` : '用户不存在' });
        return res.status(200).json({ ok: true });
      }
      const tagCmd = (msg.text || '').match(/^\/tag(?:_|\s)+(\d+)\s+(.+)$/);
      if (tagCmd) {
        const u = await addTag(Number(tagCmd[1]), tagCmd[2]);
        await api('sendMessage', { chat_id: ADMIN_ID, text: u ? `已添加标签：${tagCmd[2]}` : '用户不存在' });
        return res.status(200).json({ ok: true });
      }
      const untagCmd = (msg.text || '').match(/^\/untag(?:_|\s)+(\d+)\s+(.+)$/);
      if (untagCmd) {
        const u = await removeTag(Number(untagCmd[1]), untagCmd[2]);
        await api('sendMessage', { chat_id: ADMIN_ID, text: u ? `已移除标签：${untagCmd[2]}` : '用户不存在' });
        return res.status(200).json({ ok: true });
      }

      const malformedAdminCmd = (msg.text || '').match(/^\/(ban|unban|user|note|tag|untag|to|reply)\b(?![_\s])/);
      if (malformedAdminCmd) {
        await api('sendMessage', {
          chat_id: ADMIN_ID,
          text: '命令格式不正确。\n示例：\n/ban 123456\n/unban 123456\n/user 123456\n/to 123456\n/reply 123456 你好\n/note 123456 备注\n/tag 123456 重点\n/untag 123456 重点',
        });
        return res.status(200).json({ ok: true });
      }

      let targetUid = null;
      const replyCmd = (msg.text || '').match(/^\/reply(?:_|\s)+(\d+)\s+([\s\S]+)/);
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

    // 自动广告识别与拉黑
    const contentForDetect = msg.text || msg.caption || '';

    // 强兜底：@账号 + 推广语义，直接拉黑
    const hardSpam = /@[a-zA-Z0-9_]{4,}/.test(contentForDetect) && /(群发|验证|频道|引流|推广|自动处理验证|批量分发)/i.test(contentForDetect);
    const ad = hardSpam ? { hit: true, reason: '强规则:@账号+推广语义' } : detectAdSpam(contentForDetect);
    if (ad.hit) {
      profile = await setBan(fromId, true);
      await addTag(fromId, '自动拉黑');
      await addTag(fromId, `命中:${ad.reason}`);
      await api('sendMessage', {
        chat_id: ADMIN_ID,
        text: `🚫 已自动拉黑疑似广告用户\n用户: ${profile?.username ? '@'+profile.username : profile?.nickname || fromId}\nID: ${fromId}\n原因: ${ad.reason}\n内容: ${contentForDetect.slice(0, 120) || '[非文本媒体]'}`,
      });
      return res.status(200).json({ ok: true, auto_banned: true });
    }

    if (await isBanned(fromId)) {
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
