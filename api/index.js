export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const token = (process.env.TG_BOT_TOKEN || '').trim().replace(/^bot/i, '');
  const ADMIN_ID = Number(process.env.ADMIN_ID || '6609386680');
  const ECHO_MODE = process.env.ECHO_MODE !== 'false';

  if (!token) return res.status(500).json({ ok: false, error: 'TG_BOT_TOKEN not set' });

  const api = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json());

  // GET: 健康检查 + 可选重新绑定 webhook
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
      return res.status(200).json({ ok: true, mode: 'setup', webhook: hook, telegram: j });
    }
    return res.status(200).json({ ok: true, mode: 'relay' });
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
    const chatId = Number(msg.chat.id);

    // 管理员消息 -> 回传给目标用户
    if (fromId === ADMIN_ID) {
      if (msg.text === '/start' || msg.text === '/help') {
        await api('sendMessage', {
          chat_id: ADMIN_ID,
          text: '管理员命令：\n/reply_<用户ID> 内容\n直接回复机器人转来的那条消息也可以\n/id 查看你的 ID',
        });
        return res.status(200).json({ ok: true });
      }

      if (msg.text === '/id') {
        await api('sendMessage', { chat_id: ADMIN_ID, text: `你的 ADMIN_ID: ${ADMIN_ID}` });
        return res.status(200).json({ ok: true });
      }

      let targetUid = null;
      const cmd = (msg.text || '').match(/^\/reply_(\d+)\s+([\s\S]+)/);
      if (cmd) targetUid = Number(cmd[1]);
      if (!targetUid && msg.reply_to_message) {
        const src = msg.reply_to_message.text || msg.reply_to_message.caption || '';
        const m = src.match(/\[UID:(\d+)\]/);
        if (m) targetUid = Number(m[1]);
      }

      if (!targetUid) {
        await api('sendMessage', {
          chat_id: ADMIN_ID,
          text: 'ℹ️ 你当前是管理员会话：\n- 直接回复“机器人转发给你的用户消息”即可回传\n- 或用 /reply_用户ID 内容\n- 用 /id 查看管理员ID',
        });
        return res.status(200).json({ ok: true });
      }

      if (msg.text && cmd) {
        await api('sendMessage', { chat_id: targetUid, text: cmd[2] });
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

    // 普通用户消息 -> 转发给管理员
    const uname = msg.from.username ? ` @${msg.from.username}` : '';
    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || `用户${fromId}`;
    const header = `📨 来自匿名用户\n[UID:${fromId}]\n👤 ${name}${uname}\n\n`;

    if (msg.text) {
      await api('sendMessage', { chat_id: ADMIN_ID, text: header + msg.text });
    } else if (msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      await api('sendPhoto', { chat_id: ADMIN_ID, photo: fileId, caption: `[UID:${fromId}]\n${name}${uname}\n\n${msg.caption || ''}` });
    } else if (msg.video) {
      await api('sendVideo', { chat_id: ADMIN_ID, video: msg.video.file_id, caption: `[UID:${fromId}]\n${name}${uname}\n\n${msg.caption || ''}` });
    } else if (msg.document) {
      await api('sendDocument', { chat_id: ADMIN_ID, document: msg.document.file_id, caption: `[UID:${fromId}]\n${name}${uname}\n\n${msg.caption || ''}` });
    } else if (msg.audio) {
      await api('sendAudio', { chat_id: ADMIN_ID, audio: msg.audio.file_id, caption: `[UID:${fromId}]\n${name}${uname}\n\n${msg.caption || ''}` });
    } else if (msg.voice) {
      await api('sendVoice', { chat_id: ADMIN_ID, voice: msg.voice.file_id });
      await api('sendMessage', { chat_id: ADMIN_ID, text: `[UID:${fromId}]\n${name}${uname}\n[语音消息]` });
    } else if (msg.sticker) {
      await api('sendSticker', { chat_id: ADMIN_ID, sticker: msg.sticker.file_id });
      await api('sendMessage', { chat_id: ADMIN_ID, text: `[UID:${fromId}]\n${name}${uname}\n[贴纸]` });
    }

    if (ECHO_MODE && !((msg.text || '').startsWith('/'))) {
      await api('sendMessage', { chat_id: chatId, text: '✅ 已收到，Mark 会尽快回复你。' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.log('relay_error', e?.message || String(e));
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
