// Append-only run journal, per-date phase results (for safe resume), a single-run lockfile, atomic JSON
// files and defensive redaction. No wall clock here: timestamps come from the injected `clock`.
//
// Layout under stateDir (default ~/.local/state/arena-flywheel):
//   journal.jsonl                   every phase event of every run: {ts, date, phase, event, ...data}
//   flywheel.lock                   {pid, date, startedAt} while a run is active
//   runs/<date>/phases/<phase>.json the stored result of a completed phase (digest journaled with `done`)
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync,
  writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class LockedError extends Error {
  constructor(holder) { super(`another flywheel run holds the lock (pid ${holder?.pid ?? '?'}, date ${holder?.date ?? '?'})`); this.name = 'LockedError'; this.holder = holder; }
}

const REDACTED = '[REDACTED]';
/** Strip secret shapes from any text that may be journaled or reported (we never hold the secrets themselves). */
export function redact(text) {
  return String(text ?? '')
    .replace(/(authorization\s*[:=]\s*)("?)[^"\r\n,}]*/gi, `$1$2${REDACTED}`)
    .replace(/bearer\s+[^\s"',}]+/gi, `Bearer ${REDACTED}`)
    .replace(/hf_[A-Za-z0-9._-]{4,}/g, `hf_${REDACTED}`)
    .replace(/(["']?(?:instance_api_key|api_key|apikey|jupyter_token|token|secret|password)["']?\s*[:=]\s*)["']?[^"',\s}]+/gi, `$1${REDACTED}`);
}
export const redactDeep = v => (typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(redactDeep)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) : v);

const sha256 = text => createHash('sha256').update(text).digest('hex');

export function writeTextAtomic(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  return path;
}
export const writeJsonAtomic = (path, value) => writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export const readJsonIfExists = path => (existsSync(path) ? readJson(path) : null);

/** Default liveness probe (EPERM means the pid exists but belongs to someone else). */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Exclusive lock. A live holder throws LockedError. A dead holder (or an unreadable lock older than 60 s) is
 * reclaimed only by the holder of the RECLAIM mutex (an atomic mkdir), after re-reading the lock and finding the
 * exact stale content it inspected (lib/cache.mjs lock()). Without the mutex, two contenders that both saw the same
 * dead pid could each unlink the other's fresh lock and both run. Release removes only a lock with this run's token.
 */
export function acquireLock(stateDir, { pid, date, startedAt, isPidAlive = pidAlive }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, 'flywheel.lock');
  const reclaimDir = `${path}.reclaim`;
  const token = randomBytes(12).toString('hex');
  const body = `${JSON.stringify({ pid, date, startedAt, token })}\n`;
  const parse = text => { try { return JSON.parse(text); } catch { return null; } };
  const create = () => {
    let fd;
    try { fd = openSync(path, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    return true;
  };
  const held = reclaimed => ({ path, reclaimed,
    release() { try { if (parse(readFileSync(path, 'utf8'))?.token === token) unlinkSync(path); } catch { /* already gone */ } } });
  if (create()) return held(null);
  let seen;
  try { seen = readFileSync(path, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT' && create()) return held(null);
    throw new LockedError(null);
  }
  const holder = parse(seen);
  if (holder && Number.isSafeInteger(holder.pid) && holder.pid > 0 && isPidAlive(holder.pid)) throw new LockedError(holder);
  if (!holder) { // empty/corrupt: possibly a lock being written right now; stale only once it is old
    let age = 0;
    try { age = Date.now() - statSync(path).mtimeMs; } catch { /* removed meanwhile */ }
    if (age < 60_000) throw new LockedError(null);
  }
  try { mkdirSync(reclaimDir, { mode: 0o700 }); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // A reclaim mutex is held for microseconds; one older than 60 s belongs to a crashed process.
    try { if (Date.now() - statSync(reclaimDir).mtimeMs > 60_000) rmSync(reclaimDir, { recursive: true, force: true }); } catch { /* gone */ }
    throw new LockedError(holder);
  }
  try {
    let now = null;
    try { now = readFileSync(path, 'utf8'); } catch { /* removed meanwhile */ }
    if (now !== null && now !== seen) throw new LockedError(parse(now)); // someone else's fresh lock: leave it alone
    rmSync(path, { force: true });
    if (!create()) throw new LockedError(parse(readFileSync(path, 'utf8')));
    return held(holder ?? { unreadable: true });
  } finally {
    rmSync(reclaimDir, { recursive: true, force: true });
  }
}

/** Run `fn` as a journaled, resumable phase: a completed phase of the same date returns its stored result. */
export async function runStep(j, phase, fn) {
  const prior = j.done(phase);
  if (prior) { j.append(phase, 'resumed'); return prior; }
  j.append(phase, 'start');
  try { return j.complete(phase, await fn()); } catch (e) {
    j.append(phase, 'error', { error: redact(e?.message ?? e) });
    throw e;
  }
}

/** Journal bound to one run date. `clock()` returns the ISO timestamp for each event. */
export function openJournal({ stateDir, date, clock }) {
  if (typeof clock !== 'function') throw new Error('journal needs an injected clock');
  const path = join(stateDir, 'journal.jsonl');
  const runDir = join(stateDir, 'runs', date);
  const phasePath = phase => join(runDir, 'phases', `${phase}.json`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });

  const all = () => {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map((l, i) => {
      try { return JSON.parse(l); } catch { throw new Error(`journal_corrupt: line ${i + 1} of ${path}`); }
    });
  };
  const mine = () => all().filter(e => e.date === date);

  const j = {
    path, runDir, all, entries: mine,
    append(phase, event, data = {}) {
      const row = { ...redactDeep(data), ts: clock(), date, phase, event };
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, 'a', 0o600);
      try { writeSync(fd, `${JSON.stringify(row)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      return row;
    },
    find: (phase, event) => mine().filter(e => e.phase === phase && e.event === event),
    last: (phase, event) => j.find(phase, event).at(-1) ?? null,
    index: (phase, event) => mine().findIndex(e => e.phase === phase && e.event === event),
    /** Stored result of a completed phase, or null. The file digest must match the journaled `done`, and a phase
     *  journaled `done` whose file is gone throws: re-running only it would desynchronise it from the later phases
     *  that were built on it (a crash between the write and the `done` row leaves no `done`, so it simply re-runs). */
    done(phase) {
      const ev = j.last(phase, 'done');
      if (!ev) return null;
      if (!existsSync(phasePath(phase))) throw new Error(`phase_result_missing: ${phase} (journaled done, file gone; refusing to resume this date)`);
      const text = readFileSync(phasePath(phase), 'utf8');
      if (sha256(text) !== ev.resultSha256) throw new Error(`phase_result_tampered: ${phase}`);
      return JSON.parse(text);
    },
    /** Persist the result first, then journal `done` with its digest (a crash in between just re-runs). */
    complete(phase, result) {
      const text = `${JSON.stringify(result, null, 2)}\n`;
      writeTextAtomic(phasePath(phase), text);
      j.append(phase, 'done', { resultSha256: sha256(text) });
      return result;
    },
  };
  return j;
}
