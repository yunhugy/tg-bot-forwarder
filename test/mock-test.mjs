// test/mock-test.mjs — 不联网验证 relay 核心逻辑（用假 tg 记录调用）。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileStore } from '../lib/store.js';
import { createRelay } from '../lib/relay.js';

const ADMIN = 999;
const dir = await mkdtemp(path.join(tmpdir(), 'tg-test-'));
const calls = [];
const tg = async (method, body) => {
  calls.push({ method, body });
  return { ok: true, result: true };
};

const store = createFileStore(dir);
await store.load();
const relay = createRelay({
  config: { adminId: ADMIN, echoMode: true, github: null },
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

// 1. 普通用户发文本 → 应转发给管理员（含 UID 标签）+ 给用户回执
await relay.handleUpdate(upd({ id: 111, first_name: '小明' }, { text: '你好' }));
const fwd = sentTo(ADMIN).find((c) => c.method === 'sendMessage' && /\[UID:111\]/.test(c.body.text || ''));
check('用户消息转发给管理员(含UID标签)', !!fwd);
check('ECHO 自动回执给用户', sentTo(111).some((c) => c.body.text === '✅ 已收到。'));
check('当前对话对象=111', store.getCurrentTarget() === 111);

// 2. 广告消息 → 自动拉黑 + 通知管理员，且不再转发原文
calls.length = 0;
await relay.handleUpdate(upd({ id: 222, first_name: '广告' }, { text: '群发 @abc123 欢迎加入' }));
check('广告用户被自动拉黑', await relay.isBanned(222));
check('管理员收到拉黑通知', sentTo(ADMIN).some((c) => /自动拉黑/.test(c.body.text || '')));
check('被拉黑用户后续消息被吞掉', (await relay.handleUpdate(upd({ id: 222 }, { text: 'hi' }))).blocked === true);

// 3. 管理员 /ban /unban
calls.length = 0;
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/ban 111' }));
check('管理员 /ban 生效', await relay.isBanned(111));
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/unban 111' }));
check('管理员 /unban 生效', !(await relay.isBanned(111)));

// 4. 管理员回复转发消息 → 原路回传给用户
calls.length = 0;
await relay.handleUpdate(upd({ id: ADMIN }, { text: '收到，谢谢' }, {
  reply_to_message: { text: '小明\n你好\n\n[UID:111]' },
}));
check('回复转发消息回传给用户111', sentTo(111).some((c) => c.body.text === '收到，谢谢'));

// 5. /to 切换 + 直接发消息
calls.length = 0;
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/to 333' }));
check('/to 切换当前对象', store.getCurrentTarget() === 333);
await relay.handleUpdate(upd({ id: ADMIN }, { text: 'hello333' }));
check('直接发消息走当前对象', sentTo(333).some((c) => c.body.text === 'hello333'));

// 6. /reply_<ID> 指定回复
calls.length = 0;
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/reply_444 定向回复' }));
check('/reply_444 定向发送', sentTo(444).some((c) => c.body.text === '定向回复'));

// 7. 备注/标签
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/note 111 重要客户' }));
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/tag 111 vip' }));
const u111 = store.getUser(111);
check('备注+标签写入', u111.note === '重要客户' && u111.tags.includes('vip'), JSON.stringify({ note: u111.note, tags: u111.tags }));

// 8. 媒体转发（照片）
calls.length = 0;
await relay.handleUpdate(upd({ id: 555, first_name: '图' }, { photo: [{ file_id: 'small' }, { file_id: 'big' }], caption: '看图' }));
check('照片转发给管理员(取最大尺寸)', sentTo(ADMIN).some((c) => c.method === 'sendPhoto' && c.body.photo === 'big'));

// 9. stats / userinfo
const stats = await relay.getStats();
check('getStats 返回', stats.ok && stats.total_users >= 3, `total=${stats.total_users} banned=${stats.banned_count}`);
const info = await relay.getUserInfo(111);
check('getUserInfo 返回', info.found && info.user.id === 111);

// 10b. 裸命令提示用法（而不是掉进回复逻辑）
calls.length = 0;
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/to' }));
check('裸 /to 提示用法', sentTo(ADMIN).some((c) => /用法：\/to <用户ID>/.test(c.body.text || '')));
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/user' }));
check('裸 /user 提示用法', sentTo(ADMIN).some((c) => /用法：\/user <用户ID>/.test(c.body.text || '')));

// 10c. 待办：新消息标待处理 → /pending 列出 → 回复后自动已处理
calls.length = 0;
const FAKEU = 777001;
await relay.handleUpdate(upd({ id: FAKEU, first_name: '待办用户' }, { text: '需要帮助' }));
check('新消息标为待处理', store.getUser(FAKEU).pending === true);
calls.length = 0;
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/pending' }));
check('/pending 列出待办用户', sentTo(ADMIN).some((c) => /待处理/.test(c.body.text || '') && new RegExp(String(FAKEU)).test(c.body.text || '')));
// 管理员回复 → 自动标记已处理
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/reply_777001 好的' }));
check('管理员回复后自动已处理', store.getUser(FAKEU).pending === false);
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/done 555' })); // 清掉前面测试遗留的待处理
calls.length = 0;
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/pending' }));
check('/pending 为空时提示', sentTo(ADMIN).some((c) => /没有待处理/.test(c.body.text || '')));
// /done /reopen
await relay.handleUpdate(upd({ id: FAKEU, first_name: '待办用户' }, { text: '又有问题' }));
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/done 777001' }));
check('/done 标记已处理', store.getUser(FAKEU).pending === false);
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/reopen 777001' }));
check('/reopen 重新待处理', store.getUser(FAKEU).pending === true);
calls.length = 0;
await relay.handleUpdate(upd({ id: ADMIN }, { text: '/done' }));
check('裸 /done 提示用法', sentTo(ADMIN).some((c) => /用法：\/done <用户ID>/.test(c.body.text || '')));

// 11. 持久化：重建 store 后数据还在
await store.flush();
const store2 = createFileStore(dir);
await store2.load();
check('重启后用户数据不丢', !!store2.getUser(111) && store2.getCurrentTarget() === 777001); // 777001 是最后发消息的用户
check('重启后拉黑状态不丢', (store2.getUser(222) || {}).banned === true);
check('重启后 offset 保留', store2.getOffset() === store.getOffset());

await rm(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
