// test/verify-gate-test.mjs — 新用户验证门测试。
// 覆盖：挑战下发 → 答对放行 → 答错提示 → 老用户免验证 → 广告样本仍直接拉黑。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileStore } from '../lib/store.js';
import { createRelay } from '../lib/relay.js';

const ADMIN = 999;
const dir = await mkdtemp(path.join(tmpdir(), 'tg-verify-'));
const calls = [];
const tg = async (method, body) => {
  calls.push({ method, body });
  return { ok: true, result: true };
};

const store = createFileStore(dir);
await store.load();
// verifyGate 默认开启（与线上 bot.js 一致）
const relay = createRelay({
  config: { adminId: ADMIN, echoMode: false, github: null },
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
const lastTextTo = (uid) => {
  const ms = sentTo(uid).filter((c) => c.method === 'sendMessage');
  return ms.length ? ms[ms.length - 1].body.text : '';
};
const codeOf = (uid) => (lastTextTo(uid).match(/(\d{2})/) || [])[1] || '';

// 1. 新用户首条消息 → 不转发，收到验证码
calls.length = 0;
await relay.handleUpdate(upd({ id: 101, first_name: '新人' }, { text: '你好' }));
check('新用户首条消息不转发', !sentTo(ADMIN).some((c) => /\[UID:101\]/.test(c.body.text || '')));
check('新用户收到验证码挑战', /请回复数字/.test(lastTextTo(101)));
const code101 = codeOf(101);
check('验证码是两位数', /^\d{2}$/.test(code101));

// 2. 答错 → 提示，原消息仍不转发
calls.length = 0;
await relay.handleUpdate(upd({ id: 101 }, { text: code101 === '11' ? '22' : '11' }));
check('答错收到提示', /验证码不对/.test(lastTextTo(101)));
check('答错后仍不转发', !sentTo(ADMIN).some((c) => /\[UID:101\]/.test(c.body.text || '')));

// 3. 答对 → 暂存的原消息被转发
calls.length = 0;
await relay.handleUpdate(upd({ id: 101 }, { text: code101 }));
check('答对后原消息转发给管理员', sentTo(ADMIN).some((c) => /\[UID:101\]/.test(c.body.text || '') && /你好/.test(c.body.text || '')));

// 4. 验证后再发 → 直接转发，不再挑战
calls.length = 0;
await relay.handleUpdate(upd({ id: 101 }, { text: '第二条' }));
check('已验证用户直接转发', sentTo(ADMIN).some((c) => /\[UID:101\]/.test(c.body.text || '') && /第二条/.test(c.body.text || '')));
check('已验证用户不再收到挑战', !/请回复数字/.test(lastTextTo(101)));

// 5. 老用户（验证门上线前已有档案）→ 免验证直接转发
calls.length = 0;
store.saveUser(202, { id: 202, username: '', first_name: '老用户', nickname: '老用户', banned: false, tags: [], note: '', created_at: Date.now() - 86400000, last_seen_at: Date.now(), message_count: 5, pending: false });
await relay.handleUpdate(upd({ id: 202, first_name: '老用户' }, { text: '我是老用户' }));
check('老用户免验证直接转发', sentTo(ADMIN).some((c) => /\[UID:202\]/.test(c.body.text || '')));

// 6. 新用户发广告样本 → 直接拉黑，不走验证
calls.length = 0;
await relay.handleUpdate(upd({ id: 303, first_name: '广告号' }, { text: '南宫集团首充100赠送88' }));
check('新用户广告样本直接拉黑', await relay.isBanned(303));
check('广告用户收不到验证码', !/请回复数字/.test(lastTextTo(303)));

// 7. 管理员不受验证门影响
calls.length = 0;
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/status' }));
check('管理员命令正常', sentTo(ADMIN).some((c) => /用户数/.test(c.body.text || '')));

// 8. 验证状态持久化：重启后未验证用户再次发言仍被挑战
const store2 = createFileStore(dir);
await store2.load();
const relay2 = createRelay({ config: { adminId: ADMIN, echoMode: false, github: null }, store: store2, tg });
calls.length = 0;
await relay2.handleUpdate(upd({ id: 404, first_name: '重启前未验证' }, { text: 'hi' }));
const code404 = codeOf(404);
check('重启后未验证用户仍被挑战', /^\d{2}$/.test(code404));
await relay2.handleUpdate(upd({ id: 404 }, { text: code404 }));
check('重启后答对仍可通过', sentTo(ADMIN).some((c) => /\[UID:404\]/.test(c.body.text || '')));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
await rm(dir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
