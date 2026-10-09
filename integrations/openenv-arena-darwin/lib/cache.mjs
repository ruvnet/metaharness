// Content-addressed per-cell result cache: <cacheDir>/<cellKey>.jsonl, one JSON row per line.
// Keys are sha256 hex (validated, so a key can never traverse out of cacheDir). Writes are atomic
// (tmp file in the same directory + rename), so a crash mid-write never leaves a half cell that a
// later run would mistake for a measured one.
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const KEY = /^[a-f0-9]{64}$/;

function checkKey(key) {
  if (typeof key !== 'string' || !KEY.test(key)) throw new Error(`cache: invalid cell key "${String(key).slice(0, 80)}"`);
  return key;
}

export function createCache(cacheDir) {
  if (typeof cacheDir !== 'string' || cacheDir.length === 0) throw new Error('cache: cacheDir required');
  const dir = resolve(cacheDir);
  const pathOf = (key) => join(dir, `${checkKey(key)}.jsonl`);

  /** Rows for `key`, or null when absent. Corrupt content throws (never silently re-measured or trusted). */
  function get(key) {
    let text;
    try {
      text = readFileSync(pathOf(key), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const rows = text.split('\n').filter((line) => line.trim() !== '').map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`cache: corrupt row ${i + 1} in ${key}.jsonl`);
      }
    });
    const meta = rows.find((r) => r && r.type === 'darwin_cell');
    if (meta && meta.key !== key) throw new Error(`cache: ${key}.jsonl carries key ${meta.key}`);
    return rows;
  }

  /** Atomically write rows for `key` (replaces any previous content). */
  function put(key, rows) {
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('cache: rows must be a non-empty array');
    const target = pathOf(key);
    mkdirSync(dir, { recursive: true });
    const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const tmp = join(dir, `.${key}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeFileSync(tmp, body, { flag: 'wx' });
      renameSync(tmp, target);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    return target;
  }

  /**
   * Exclusive same-host lock on measuring `key` (Darwin evaluates children concurrently; two
   * children can need the same unmeasured cell). Returns a release function, or null when another
   * process holds it. A lock whose pid is dead (or unreadable and >60s old) is stale, and only the
   * holder of the per-key RECLAIM mutex (an atomic mkdir) may remove it, after re-reading it and
   * finding the exact stale content it inspected. Without that mutex, two contenders that both saw
   * the same dead pid could each delete the other's fresh lock and both measure the cell.
   * Release only removes a lock that still carries this holder's random token.
   */
  function lock(key) {
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, `${checkKey(key)}.lock`);
    const reclaimDir = `${lockPath}.reclaim`;
    const token = randomBytes(12).toString('hex');
    const body = JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() });
    const release = () => {
      try { if (JSON.parse(readFileSync(lockPath, 'utf8')).token === token) rmSync(lockPath, { force: true }); } catch { /* gone */ }
    };
    const create = () => {
      try { writeFileSync(lockPath, body, { flag: 'wx' }); return true; } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
      }
    };
    if (create()) return release;
    let seen;
    try { seen = readFileSync(lockPath, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return create() ? release : null;
      throw error;
    }
    let pid = null;
    try { pid = JSON.parse(seen).pid; } catch { /* being written, or corrupt */ }
    if (pid === null) {
      let age = 0;
      try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { return null; }
      if (age < 60_000) return null;
    } else if (pidAlive(pid)) {
      return null;
    }
    try { mkdirSync(reclaimDir); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A reclaim mutex is held for microseconds; one older than 60s belongs to a crashed process.
      try { if (Date.now() - statSync(reclaimDir).mtimeMs > 60_000) rmSync(reclaimDir, { recursive: true, force: true }); } catch { /* gone */ }
      return null; // retry later
    }
    try {
      let now = null;
      try { now = readFileSync(lockPath, 'utf8'); } catch { /* removed meanwhile */ }
      if (now !== null && now !== seen) return null; // someone else's (fresh) lock now: leave it alone
      rmSync(lockPath, { force: true });
      return create() ? release : null;
    } finally {
      rmSync(reclaimDir, { recursive: true, force: true });
    }
  }

  return { dir, get, put, lock, has: (key) => get(key) !== null, path: pathOf };
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
