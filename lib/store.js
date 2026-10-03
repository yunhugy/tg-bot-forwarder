// lib/store.js — 文件持久化存储，替代 Vercel 版的 Redis/内存/Upstash。
// 状态保存在 <dataDir>/state.json，写操作防抖 2 秒落盘，进程退出时 flush。
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function createFileStore(dataDir) {
  const file = path.join(dataDir, 'state.json');
  let state = { users: {}, recent: [], currentTarget: null, offset: 0 };
  let dirty = false;
  let timer = null;
  let loaded = false;

  async function load() {
    if (loaded) return state;
    loaded = true;
    try {
      await fs.mkdir(dataDir, { recursive: true });
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state = {
          users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
          recent: Array.isArray(parsed.recent) ? parsed.recent : [],
          currentTarget: parsed.currentTarget ?? null,
          offset: Number(parsed.offset) || 0,
        };
      }
    } catch {
      // 首次运行：保持空状态
    }
    return state;
  }

  function scheduleSave() {
    dirty = true;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        flush().catch((e) => console.error('[store] flush failed:', e.message));
      }, 2000);
      // 允许进程在仅剩定时器时正常退出（退出前会显式 flush）
      timer.unref?.();
    }
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return;
    dirty = false;
    const tmp = file + '.tmp';
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(state), 'utf8');
    await fs.rename(tmp, file);
  }

  function getUser(uid) {
    return state.users[String(uid)] || null;
  }

  function saveUser(uid, data) {
    const key = String(uid);
    state.users[key] = data;
    state.recent = [key, ...state.recent.filter((x) => x !== key)].slice(0, 1000);
    scheduleSave();
  }

  function listRecentUsers(limit = 20) {
    return state.recent.slice(0, limit).map((id) => state.users[id]).filter(Boolean);
  }

  function getAllUsers() {
    return Object.values(state.users);
  }

  function getOffset() {
    return state.offset;
  }

  function setOffset(offset) {
    if (offset !== state.offset) {
      state.offset = offset;
      scheduleSave();
    }
  }

  function getCurrentTarget() {
    return state.currentTarget || null;
  }

  function setCurrentTarget(uid) {
    state.currentTarget = uid == null ? null : Number(uid);
    scheduleSave();
  }

  return {
    load, flush,
    getUser, saveUser, listRecentUsers, getAllUsers,
    getOffset, setOffset, getCurrentTarget, setCurrentTarget,
  };
}
