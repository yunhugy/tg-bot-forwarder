// test/ad-samples-test.mjs — 真实广告样本的模拟验证。
// 用 2026-10-05 真实命中的博彩广告原文，验证：关键词命中 → 自动拉黑 → 推送管理员。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileStore } from '../lib/store.js';
import { createRelay } from '../lib/relay.js';
import { AD_SAMPLE_KEYWORDS, matchAdSample } from '../lib/ad-samples.js';

const ADMIN = 999;
const dir = await mkdtemp(path.join(tmpdir(), 'tg-adtest-'));
const calls = [];
const tg = async (method, body) => {
  calls.push({ method, body });
  return { ok: true, result: true };
};

const store = createFileStore(dir);
await store.load();
const relay = createRelay({
  // verifyGate:false —— 本文件测广告样本识别；验证门由 test/verify-gate-test.mjs 覆盖
  config: { adminId: ADMIN, echoMode: false, github: null, verifyGate: false },
  store, tg,
});

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
}
const sentTo = (uid) => calls.filter((c) => c.body && Number(c.body.chat_id) === uid);
let n = 0;
const upd = (from, msg, extra = {}) => ({
  update_id: ++n,
  message: { message_id: n, from, chat: { id: from.id }, ...msg, ...extra },
});

// ---- 真实样本原文（2026-10-05，用户 6648773384，节选自拉黑记录） ----
const SAMPLE_1 = `不要去等明天，不要去相信永远，你所能做的，就是眼前。你所能做的，就是让自己更快、更强。

南宫集团⚡️大量活动详情咨询
➖➖➖➖➖➖➖➖
🧧首充100赠送88
🧧首充500赠送288
🧧首充1000赠送488
➖➖➖➖➖➖➖➖
复制到浏览器打开即可👇
⚡️   jhp70.top
⚡️   sut56.top
⚡️   f47uu.top
电子模拟器`;

const SAMPLE_2 = `南宫集团新会员首充赠送，详情咨询客服`;

// 1. 关键词库非空且命中样本
check('关键词库非空', AD_SAMPLE_KEYWORDS.length >= 4, `${AD_SAMPLE_KEYWORDS.length} 个`);
check('样本1命中(南宫集团)', matchAdSample(SAMPLE_1).hit && matchAdSample(SAMPLE_1).keyword === '南宫集团');
check('样本2命中(南宫集团)', matchAdSample(SAMPLE_2).hit);
check('正常消息不命中', !matchAdSample('你好，请问这个 bot 是做什么的').hit);
check('空消息不命中', !matchAdSample('').hit);

// 2. 端到端：样本1 → 自动拉黑 + 推送管理员 + 原文不转发
calls.length = 0;
await relay.handleUpdate(upd({ id: 555, first_name: ' spammer', username: 'spam1' }, { text: SAMPLE_1 }));
check('样本1发送者被自动拉黑', await relay.isBanned(555));
const notice = sentTo(ADMIN).find((c) => /自动拉黑/.test(c.body.text || ''));
check('管理员收到拉黑通知', !!notice);
check('通知中注明样本关键词', !!notice && /样本关键词/.test(notice.body.text));
check('通知中包含命中词', !!notice && /南宫集团/.test(notice.body.text));
check('广告原文未转发给管理员', !sentTo(ADMIN).some((c) => /jhp70\.top/.test(c.body.text || '')));
check('被拉黑后消息被吞', (await relay.handleUpdate(upd({ id: 555 }, { text: 'hi' }))).blocked === true);

// 3. 端到端：样本2（变体：数字不同）→ 同样命中
calls.length = 0;
await relay.handleUpdate(upd({ id: 556, first_name: 'spammer2' }, { text: '首充200赠送188，电子模拟器新玩法' }));
check('样本变体被自动拉黑', await relay.isBanned(556));

// 4. 正常用户不受影响
calls.length = 0;
await relay.handleUpdate(upd({ id: 557, first_name: '小明' }, { text: '你好，在吗' }));
check('正常用户不被拉黑', !(await relay.isBanned(557)));
check('正常消息照常转发', sentTo(ADMIN).some((c) => /\[UID:557\]/.test(c.body.text || '')));

// 5. 旧的启发式检测不受影响
check('启发式检测仍可用', relay.detectAdSpam('群发 @abc123 欢迎加入').hit);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
await rm(dir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
