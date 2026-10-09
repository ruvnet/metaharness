// Thin subprocess wrapper around the ruvector CLI (create / insert / search / stats).
//
// Facts measured against ruvector@0.3.3 (native @ruvector/core backend) and encoded here:
// - A cosine store's search `Score` is a DISTANCE (identical -> 0.0000, orthogonal -> 1, antipodal -> 2),
//   printed with 4 decimals. Similarity = 1 - score. `-t/--threshold` is not forwarded by the CLI's
//   VectorDB wrapper, so it is never used; callers take `-k` results and filter client-side.
// - The store is a redb file with an exclusive lock: concurrent searches fail with
//   "Database already open. Cannot acquire lock." Every call here is serialized by the caller.
// - Results are printed to stdout; spinner/status lines go to stderr. Only stdout is parsed.
// - The output format is version-specific, so the default command pins the version.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const RUVECTOR_VERSION = '0.3.3';
export const RUVECTOR_DEFAULT_CMD = ['npx', '-y', `ruvector@${RUVECTOR_VERSION}`];
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Run one command; resolve {code, stdout, stderr}. Never rejects on nonzero exit. */
export function runCommand(argv, { timeoutMs = 120_000 } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); stderr += `\n[timeout after ${timeoutMs}ms]`; }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); fail(err); });
    child.on('close', code => { clearTimeout(timer); done({ code: code ?? -1, stdout, stderr }); });
  });
}

/** Parse `ruvector search` stdout into [{rank, id, distance}]. Throws on an unrecognised format. */
export function parseSearchOutput(stdout) {
  const text = String(stdout).replace(ANSI, '');
  if (!/Search Results:/.test(text)) throw new Error('ruvector_search_output_unrecognised');
  const out = [];
  const re = /^\s*(\d+)\.\s+ID:\s+(\S+)\s*\r?\n\s*Score:\s+(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gim;
  for (let m; (m = re.exec(text));) {
    const distance = Number(m[3]);
    if (!Number.isFinite(distance) || distance < -1e-6) throw new Error('ruvector_search_distance_invalid');
    out.push({ rank: Number(m[1]), id: m[2], distance });
  }
  if (out.some((r, i) => r.rank !== i + 1)) throw new Error('ruvector_search_rank_gap');
  return out;
}

/** Parse `ruvector stats` stdout for the vector count. */
export function parseStatsCount(stdout) {
  const m = /Vector Count:\s+(\d+)/.exec(String(stdout).replace(ANSI, ''));
  if (!m) throw new Error('ruvector_stats_output_unrecognised');
  return Number(m[1]);
}

/**
 * A single-file ruvector store at <dbDir>/<name>. `reset()` deletes exactly that file and its
 * `.meta.json` sidecar (nothing else), so each run starts from a fresh, reproducible store.
 */
export function ruvectorStore({ dbDir, name = 'failures.db', cmd = RUVECTOR_DEFAULT_CMD, timeoutMs = 120_000 } = {}) {
  if (!dbDir) throw new Error('ruvector_db_dir_required');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || name.startsWith('.')) throw new Error('ruvector_db_name_invalid');
  const dir = resolve(dbDir);
  const db = join(dir, name);
  const exec = async (args, step) => {
    const r = await runCommand([...cmd, ...args], { timeoutMs });
    if (r.code !== 0) throw new Error(`ruvector_${step}_failed: ${(r.stderr || r.stdout).replace(ANSI, '').trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`);
    return r.stdout;
  };
  return {
    db, cmd: cmd.join(' '),
    async version() { return (await exec(['--version'], 'version')).trim(); },
    reset() {
      mkdirSync(dir, { recursive: true });
      rmSync(db, { force: true });
      rmSync(`${db}.meta.json`, { force: true });
    },
    async create(dim) {
      if (!Number.isInteger(dim) || dim < 1 || dim > 4096) throw new Error('ruvector_dim_invalid');
      await exec(['create', db, '-d', String(dim), '-m', 'cosine'], 'create');
    },
    async insert(entries) {
      for (const e of entries) if (!SAFE_ID.test(e.id)) throw new Error(`ruvector_id_unsafe:${e.id}`);
      const file = join(dir, `${name}.insert.json`);
      writeFileSync(file, JSON.stringify(entries));
      await exec(['insert', db, file], 'insert');
    },
    async count() { return parseStatsCount(await exec(['stats', db], 'stats')); },
    async search(vector, k) {
      if (!Number.isInteger(k) || k < 1 || k > 1000) throw new Error('ruvector_k_invalid');
      return parseSearchOutput(await exec(['search', db, '-v', JSON.stringify(vector), '-k', String(k)], 'search'));
    },
  };
}

/** Cosine similarity; throws on a non-finite result (zero or non-finite vectors). */
export function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const s = d / Math.sqrt(na * nb);
  if (!Number.isFinite(s)) throw new Error('cosine_not_finite');
  return s;
}

/**
 * kNN through ruvector: fresh store, insert all vectors, one serial search per vector (k+1, self dropped).
 * Receipts: stats count === n; each query finds itself at distance ~0 (unless the k+1 slots are all
 * exact ties); every returned distance agrees with in-process (1 - cosine) to 0.01.
 */
export async function knnRuvector(items, k, store) {
  store.reset();
  await store.create(items[0].vector.length);
  await store.insert(items.map(e => ({ id: e.id, vector: e.vector, metadata: e.metadata ?? {} })));
  const count = await store.count();
  if (count !== items.length) throw new Error(`ruvector_count_mismatch:${count}!=${items.length}`);
  const byId = new Map(items.map(e => [e.id, e])), out = new Map();
  let maxAbsErr = 0, selfHits = 0;
  for (const q of items) {
    const res = await store.search(q.vector, Math.min(k + 1, items.length));
    if (!res.length) throw new Error(`ruvector_empty_result:${q.id}`);
    const self = res.find(r => r.id === q.id);
    if (self && self.distance <= 1e-3) selfHits++;
    else if (res[res.length - 1].distance > 1e-6) throw new Error(`ruvector_self_match_missing:${q.id}`);
    const nb = [];
    for (const r of res) {
      const hit = byId.get(r.id);
      if (!hit) throw new Error(`ruvector_unknown_id:${r.id}`);
      if (r.id === q.id) continue;
      maxAbsErr = Math.max(maxAbsErr, Math.abs(r.distance - (1 - cosine(q.vector, hit.vector))));
      nb.push({ id: r.id, sim: 1 - r.distance });
    }
    out.set(q.id, nb.slice(0, k));
  }
  if (maxAbsErr > 0.01) throw new Error(`ruvector_distance_disagrees_with_cosine:${maxAbsErr}`);
  return { neighbors: out, receipt: { db: store.db, cmd: store.cmd, count, searches: items.length, selfHits, maxAbsErr } };
}
