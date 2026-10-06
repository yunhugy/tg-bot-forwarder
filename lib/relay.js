// lib/relay.js — 从 Vercel 版 api/index.js 移植的核心业务逻辑。
// 与运行环境解耦：通过注入的 { config, store, tg } 工作，
// 既可用于轮询模式，也可复用于其他接入方式。
import { matchAdSample } from './ad-samples.js';

export function createRelay({ config, store, tg }) {
  const ADMIN_ID = config.adminId;
  const ECHO_MODE = config.echoMode;
  const VERIFY_GATE = config.verifyGate !== false; // 新用户验证门，默认开启；设 VERIFY_NEW_USERS=0 可关闭
  const gh = config.github || null;

  // 新用户验证：uid -> { code, heldMsg, challengedAt }（进程内暂存；verified 状态持久化在用户档案）
  const pendingVerify = new Map();
  const newVerifyCode = () => String(Math.floor(10 + Math.random() * 90));

  // 内存硬拉黑集合（进程内快速判定；持久化以用户记录 banned 字段为准）
  const hardBans = new Set();
  for (const u of store.getAllUsers()) {
    if (u && u.banned) hardBans.add(String(u.id));
  }

  // ---- GitHub bans.json 同步（含 60 秒缓存，避免每条消息都请求 API）----
  let ghCache = { map: {}, sha: null, at: 0 };
  const GH_CACHE_TTL = 60 * 1000;

  async function ghGetBans(force = false) {
    if (!gh) return { map: {}, sha: null };
    const now = Date.now();
    if (!force && now - ghCache.at < GH_CACHE_TTL) return ghCache;
    const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${encodeURIComponent(gh.bansPath)}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${gh.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'tg-forwarder-local' },
    });
    if (r.status === 404) {
      ghCache = { map: {}, sha: null, at: now };
      return ghCache;
    }
    const d = await r.json();
    const txt = Buffer.from(d.content || '', 'base64').toString('utf8') || '{}';
    let map = {};
    try { map = JSON.parse(txt); } catch { map = {}; }
    ghCache = { map, sha: d.sha || null, at: now };
    return ghCache;
  }

  async function ghPutBans(map, sha) {
    if (!gh) return false;
    const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${encodeURIComponent(gh.bansPath)}`;
    const body = {
      message: 'chore: update bans.json by bot',
      content: Buffer.from(JSON.stringify(map, null, 2), 'utf8').toString('base64'),
      branch: 'main',
    };
    if (sha) body.sha = sha;
    const r = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${gh.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'tg-forwarder-local' },
      body: JSON.stringify(body),
    });
    ghCache = { map: { ...map }, sha: null, at: 0 }; // 写后失效，下次重拉
    return r.ok;
  }

  function profileTitle(u) {
    return u?.username ? `@${u.username}` : (u?.nickname || `用户${u?.id || ''}`);
  }

  function blankProfile(uid) {
    return {
      id: uid, username: '', first_name: '', last_name: '', nickname: `用户${uid}`,
      banned: false, tags: [], note: '', created_at: Date.now(),
      last_seen_at: Date.now(), last_message_preview: '', message_count: 0,
      pending: false, pending_since: 0,
    };
  }

  function formatWait(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return '不到1分钟';
    if (m < 60) return `${m}分钟`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}小时`;
    return `${Math.floor(h / 24)}天`;
  }

  async function ensureProfile(from) {
    const uid = Number(from.id);
    const old = store.getUser(uid);
    const p = old || blankProfile(uid);
    p.username = from.username || p.username || '';
    p.first_name = from.first_name || p.first_name || '';
    p.last_name = from.last_name || p.last_name || '';
    p.nickname = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || p.nickname;
    p.last_seen_at = Date.now();
    store.saveUser(uid, p);
    return p;
  }

  async function updateProfileMessage(uid, preview) {
    const p = store.getUser(uid);
    if (!p) return null;
    p.last_message_preview = String(preview || '').slice(0, 180);
    p.last_seen_at = Date.now();
    p.message_count = (p.message_count || 0) + 1;
    store.saveUser(uid, p);
    return p;
  }

  async function setBan(uid, banned) {
    const u = Number(uid);
    const p = store.getUser(u) || blankProfile(u);
    p.banned = !!banned;
    store.saveUser(u, p);
    if (banned) hardBans.add(String(u)); else hardBans.delete(String(u));
    if (gh) {
      const { map, sha } = await ghGetBans(true);
      map[String(u)] = !!banned;
      await ghPutBans(map, sha);
    }
    return p;
  }

  async function isBanned(uid) {
    const u = store.getUser(uid);
    if (u?.banned) return true;
    if (hardBans.has(String(uid))) return true;
    if (gh) {
      const { map } = await ghGetBans();
      if (map[String(uid)] === true) return true;
    }
    return false;
  }

  async function setNote(uid, note) {
    const u = Number(uid);
    const p = store.getUser(u) || blankProfile(u);
    p.note = String(note || '').trim();
    store.saveUser(u, p);
    return p;
  }

  async function addTag(uid, tag) {
    const u = Number(uid);
    const p = store.getUser(u) || blankProfile(u);
    const t = String(tag || '').trim();
    p.tags = Array.isArray(p.tags) ? p.tags : [];
    if (t && !p.tags.includes(t)) p.tags.push(t);
    store.saveUser(u, p);
    return p;
  }

  async function removeTag(uid, tag) {
    const u = Number(uid);
    const p = store.getUser(u);
    if (!p) return null;
    const t = String(tag || '').trim();
    p.tags = (p.tags || []).filter((x) => x !== t);
    store.saveUser(u, p);
    return p;
  }

  function detectAdSpam(text = '') {
    const raw = String(text || '');
    if (!raw.trim()) return { hit: false, reason: '' };
    let score = 0;
    const hits = [];
    const add = (ok, s, n) => { if (ok) { score += s; hits.push(n); } };
    add(/(t\.me\/|telegram\.me\/|tg\s*[:：]?\s*@|频道[:：]?\s*@|群[:：]?\s*@|私聊[:：]?\s*@)/i.test(raw), 5, 'TG引流');
    add(/@[a-zA-Z0-9_]{4,}/.test(raw), 2, '@账号');
    add(/(https?:\/\/|www\.)/i.test(raw), 3, '外链');
    add(/(群发|引流|推广|广告|渠道|频道|加群|拉群|进群|私聊|联系)/i.test(raw), 2, '推广语义');
    add(/(自动处理验证|自动验证|批量分发|代发|推广系统|脚本群发|机器人群发)/i.test(raw), 4, '自动化群发');
    add(/(代理|返佣|分成|拉新|首充|送彩金|高返|稳赚|带单|导师|包赔|包赚)/i.test(raw), 4, '诈骗灰产');
    if (/@[a-zA-Z0-9_]{4,}/.test(raw) && /(群发|批量分发|自动处理验证|推广|引流)/i.test(raw)) {
      score += 6;
      hits.push('组合命中');
    }
    return score >= 6 ? { hit: true, reason: hits.slice(0, 3).join('+') } : { hit: false, reason: '' };
  }

  // ---- 管理员分支 ----
  async function handleAdmin(msg) {
    const txt = String(msg.text || '');

    if (txt === '/start' || txt === '/help') {
      await tg('sendMessage', { chat_id: ADMIN_ID, text: '管理员命令:\n/users - 最近用户\n/pending - 待处理列表\n/done <ID> - 标记已处理\n/reopen <ID> - 重新标为待处理\n/current - 当前回复对象\n/to <ID> - 切换回复对象\n/reply <ID> 内容 - 指定回复\n/ban <ID> - 拉黑\n/unban <ID> - 取消拉黑\n/user <ID> - 查看资料\n/note <ID> 备注 - 设置备注\n/tag <ID> 标签 - 添加标签\n/untag <ID> 标签 - 移除标签\n/status - 状态\n/id - 管理员ID' });
      return { ok: true };
    }
    if (txt === '/id') {
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `ADMIN_ID: ${ADMIN_ID}` });
      return { ok: true };
    }
    if (txt === '/status') {
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `存储: 本地文件\n用户数: ${store.getAllUsers().length}` });
      return { ok: true };
    }
    if (txt === '/users') {
      const users = store.listRecentUsers(20);
      if (!users.length) {
        await tg('sendMessage', { chat_id: ADMIN_ID, text: '暂无用户记录' });
        return { ok: true };
      }
      const lines = users.map((u, i) => `${i + 1}. ${profileTitle(u)}\nID: ${u.id}\n最近: ${u.last_message_preview || '-'}`).join('\n\n');
      await tg('sendMessage', { chat_id: ADMIN_ID, text: lines });
      return { ok: true };
    }
    if (txt === '/pending') {
      const pend = store.getAllUsers()
        .filter((u) => u.pending)
        .sort((a, b) => (a.pending_since || 0) - (b.pending_since || 0));
      if (!pend.length) {
        await tg('sendMessage', { chat_id: ADMIN_ID, text: '没有待处理的用户 🎉' });
        return { ok: true };
      }
      const lines = pend.slice(0, 20).map((u, i) => {
        const wait = formatWait(Date.now() - (u.pending_since || Date.now()));
        return `${i + 1}. ${profileTitle(u)}（已等${wait}）\nID: ${u.id}\n最近: ${u.last_message_preview || '-'}`;
      }).join('\n\n');
      const more = pend.length > 20 ? `\n\n…还有 ${pend.length - 20} 个` : '';
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `待处理（${pend.length}）：\n\n${lines}${more}` });
      return { ok: true };
    }
    if (txt === '/current') {
      const cur = store.getCurrentTarget();
      if (!cur) {
        await tg('sendMessage', { chat_id: ADMIN_ID, text: '当前没有选中的回复对象' });
      } else {
        const u = store.getUser(cur);
        await tg('sendMessage', { chat_id: ADMIN_ID, text: `当前回复对象：${u ? profileTitle(u) : cur} (${cur})` });
      }
      return { ok: true };
    }

    // 裸命令（没带参数）直接提示用法，避免掉进回复逻辑造成困惑
    const usageHints = {
      to: '/to <用户ID> - 切换当前回复对象',
      ban: '/ban <用户ID> - 拉黑用户',
      unban: '/unban <用户ID> - 取消拉黑',
      user: '/user <用户ID> - 查看用户资料',
      note: '/note <用户ID> 备注内容 - 设置备注',
      tag: '/tag <用户ID> 标签 - 添加标签',
      untag: '/untag <用户ID> 标签 - 移除标签',
      reply: '/reply <用户ID> 内容 - 指定回复用户',
      done: '/done <用户ID> - 标记为已处理',
      reopen: '/reopen <用户ID> - 重新标为待处理',
    };
    const bare = txt.match(/^\/(to|ban|unban|user|note|tag|untag|reply|done|reopen)$/);
    if (bare) {
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `用法：${usageHints[bare[1]]}` });
      return { ok: true };
    }

    const toCmd = txt.match(/^\/to(?:_|\s)+(\d+)$/);
    if (toCmd) {
      store.setCurrentTarget(Number(toCmd[1]));
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `已切换当前回复对象：${toCmd[1]}` });
      return { ok: true };
    }

    const banCmd = txt.match(/^\/ban(?:_|\s)+(\d+)$/);
    if (banCmd) {
      const u = await setBan(Number(banCmd[1]), true);
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `已拉黑 ${u.id}` });
      return { ok: true };
    }

    const unbanCmd = txt.match(/^\/unban(?:_|\s)+(\d+)$/);
    if (unbanCmd) {
      const u = await setBan(Number(unbanCmd[1]), false);
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `已取消拉黑 ${u.id}` });
      return { ok: true };
    }

    const userCmd = txt.match(/^\/user(?:_|\s)+(\d+)$/);
    if (userCmd) {
      const u = store.getUser(Number(userCmd[1]));
      await tg('sendMessage', {
        chat_id: ADMIN_ID,
        text: u
          ? `用户资料\n姓名: ${u.nickname}\n用户名: ${u.username || '-'}\nID: ${u.id}\n状态: ${await isBanned(u.id) ? '已拉黑' : '正常'}\n备注: ${u.note || '-'}\n标签: ${(u.tags || []).join(', ') || '-'}\n消息数: ${u.message_count || 0}\n最近: ${u.last_message_preview || '-'}`
          : '用户不存在',
      });
      return { ok: true };
    }

    const noteCmd = txt.match(/^\/note(?:_|\s)+(\d+)\s+([\s\S]+)$/);
    if (noteCmd) {
      const u = await setNote(Number(noteCmd[1]), noteCmd[2]);
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `已设置备注：${u.note}` });
      return { ok: true };
    }

    const tagCmd = txt.match(/^\/tag(?:_|\s)+(\d+)\s+([\s\S]+)$/);
    if (tagCmd) {
      await addTag(Number(tagCmd[1]), tagCmd[2]);
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `已添加标签：${tagCmd[2]}` });
      return { ok: true };
    }

    const untagCmd = txt.match(/^\/untag(?:_|\s)+(\d+)\s+([\s\S]+)$/);
    if (untagCmd) {
      const u = await removeTag(Number(untagCmd[1]), untagCmd[2]);
      await tg('sendMessage', { chat_id: ADMIN_ID, text: u ? `已移除标签：${untagCmd[2]}` : '用户不存在' });
      return { ok: true };
    }

    const doneCmd = txt.match(/^\/done(?:_|\s)+(\d+)$/);
    if (doneCmd) {
      const u = store.getUser(Number(doneCmd[1]));
      if (!u) {
        await tg('sendMessage', { chat_id: ADMIN_ID, text: '用户不存在' });
        return { ok: true };
      }
      u.pending = false;
      store.saveUser(u.id, u);
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `✅ ${profileTitle(u)} 已标记为已处理` });
      return { ok: true };
    }

    const reopenCmd = txt.match(/^\/reopen(?:_|\s)+(\d+)$/);
    if (reopenCmd) {
      const u = store.getUser(Number(reopenCmd[1]));
      if (!u) {
        await tg('sendMessage', { chat_id: ADMIN_ID, text: '用户不存在' });
        return { ok: true };
      }
      u.pending = true;
      u.pending_since = Date.now();
      store.saveUser(u.id, u);
      await tg('sendMessage', { chat_id: ADMIN_ID, text: `↩️ ${profileTitle(u)} 已重新标为待处理` });
      return { ok: true };
    }

    // 回复转发：/reply_<ID> / 回复转发消息 / 当前选中对象
    let targetUid = null;
    const replyCmd = txt.match(/^\/reply(?:_|\s)+(\d+)\s+([\s\S]+)/);
    if (replyCmd) targetUid = Number(replyCmd[1]);
    if (!targetUid && msg.reply_to_message) {
      const src = msg.reply_to_message.text || msg.reply_to_message.caption || '';
      const m = src.match(/\[UID:(\d+)\]/);
      if (m) targetUid = Number(m[1]);
    }
    if (!targetUid) targetUid = store.getCurrentTarget();
    if (!targetUid) {
      await tg('sendMessage', { chat_id: ADMIN_ID, text: '当前没有可回复用户，先等用户发消息或 /to <ID>' });
      return { ok: true };
    }

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

    // 回复了就自动标为已处理，不用再手动 /done
    const target = store.getUser(targetUid);
    if (target && target.pending) {
      target.pending = false;
      store.saveUser(targetUid, target);
    }

    await tg('sendMessage', { chat_id: ADMIN_ID, text: `✅ 已发送给 ${targetUid}` });
    return { ok: true };
  }

  // ---- 用户分支 ----
  async function handleUser(msg) {
    const fromId = Number(msg.from.id);
    const isFirstContact = !store.getUser(fromId);
    let p = await ensureProfile(msg.from);
    p = await updateProfileMessage(fromId, msg.text || msg.caption || '[媒体]');
    store.setCurrentTarget(fromId);

    if (await isBanned(fromId)) return { ok: true, blocked: true };

    const content = msg.text || msg.caption || '';
    // 样本关键词优先：命中真实广告样本原文即拉黑（精确字面匹配，不做语义泛化）
    const sampleHit = matchAdSample(content);
    const hardSpam = /@[a-zA-Z0-9_]{4,}/.test(content) && /(群发|验证|频道|引流|推广|自动处理验证|批量分发)/i.test(content);
    const ad = sampleHit.hit
      ? { hit: true, reason: `样本关键词:${sampleHit.keyword}` }
      : hardSpam ? { hit: true, reason: '强规则:@账号+推广语义' } : detectAdSpam(content);
    if (ad.hit) {
      p = await setBan(fromId, true);
      await tg('sendMessage', {
        chat_id: ADMIN_ID,
        text: `🚫 已自动拉黑疑似广告用户\n用户: ${profileTitle(p)}\nID: ${fromId}\n原因: ${ad.reason}\n内容: ${content.slice(0, 120) || '[非文本媒体]'}`,
      });
      return { ok: true, auto_banned: true };
    }

    // ---- 新用户验证门：未验证的新用户先回复数字验证码，防脚本群发 ----
    // 老用户（验证门上线前已有档案）默认视为已验证，不打扰。
    if (VERIFY_GATE && (isFirstContact || p.verified === false)) {
      const text = String(msg.text || '').trim();
      const pending = pendingVerify.get(fromId);
      // 答对：标记已验证，转交暂存的消息
      if (pending && text === pending.code) {
        pendingVerify.delete(fromId);
        p.verified = true;
        store.saveUser(fromId, p);
        await tg('sendMessage', { chat_id: fromId, text: '验证通过，之前那条消息已转交。' });
        return handleUser(pending.heldMsg);
      }
      // 纯数字但答错：提示，不动暂存的消息
      if (pending && /^\d+$/.test(text)) {
        await tg('sendMessage', { chat_id: fromId, text: `验证码不对，请回复数字 ${pending.code}。` });
        return { ok: true, verify_pending: true };
      }
      // 首次或挑战超过 5 分钟：发新验证码
      if (!pending || Date.now() - pending.challengedAt > 5 * 60 * 1000) {
        const code = newVerifyCode();
        pendingVerify.set(fromId, { code, heldMsg: msg, challengedAt: Date.now() });
        await tg('sendMessage', { chat_id: fromId, text: `欢迎使用！请回复数字 ${code} 完成验证（防广告机器人），验证后即可正常留言。` });
      } else {
        pending.heldMsg = msg; // 验证前只暂存最新一条
      }
      p.verified = false;
      store.saveUser(fromId, p);
      return { ok: true, verify_pending: true };
    }

    // 新消息 → 标为待处理（已在待处理中则保留最早的 pending_since，等待时长才准确）
    if (!p.pending) {
      p.pending = true;
      p.pending_since = Date.now();
      store.saveUser(fromId, p);
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

    return { ok: true };
  }

  async function handleUpdate(update) {
    const msg = update && update.message;
    if (!msg || !msg.from || !msg.chat) return { ok: true, skipped: true };
    const fromId = Number(msg.from.id);
    if (fromId === ADMIN_ID) return handleAdmin(msg);
    return handleUser(msg);
  }

  // ---- 本地管理接口（带鉴权，原 Vercel 版 ?stats=1 / ?uid= 公开问题已修复）----
  async function getStats() {
    const users = store.listRecentUsers(500);
    const bannedUsers = [];
    for (const u of users) {
      if (await isBanned(u.id)) {
        bannedUsers.push({ id: u.id, username: u.username || '', nickname: u.nickname || '' });
      }
    }
    return {
      ok: true,
      storage: 'local-file' + (gh ? '+github_bans' : ''),
      total_users: users.length,
      banned_count: bannedUsers.length,
      banned_users: bannedUsers.slice(0, 100),
    };
  }

  async function getUserInfo(uid) {
    const user = store.getUser(Number(uid));
    return { ok: true, uid: Number(uid), found: !!user, user };
  }

  return { handleUpdate, handleAdmin, handleUser, getStats, getUserInfo, isBanned, detectAdSpam, matchAdSample };
}
