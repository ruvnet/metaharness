// Thin wrapper over the vastai CLI (v1.6.0) that encodes its quirks. Every call:
//   - runs with --raw and NEVER --api-key/--explain/--curl (they put the key in argv or print it);
//   - gets a minimal child env: PATH, HOME, VASTAI_NO_UPDATE_CHECK=1 and VAST_API_KEY (the only place
//     the key ever lives outside this closure);
//   - succeeds only on exit 0 AND parseable stdout AND no `{"error": true}` on stderr. In --raw mode an
//     HTTP error exits 0 with empty stdout and a JSON error on stderr; only transport failures exit 1.
// Raw stdout/stderr never leave this module. Errors carry fixed text plus a short redacted `msg`.
// `create instance` stdout contains `instance_api_key`; only `success` and `new_contract` are kept.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

const FORBIDDEN = new Set(['--api-key', '--explain', '--curl']);

/** Vast key from Secret Manager, at use time. stderr is discarded; the value is never echoed. */
export function fetchVastKey({ pathEnv = process.env.PATH } = {}) {
  return new Promise((resolve, reject) => {
    execFile(resolveBin('gcloud', pathEnv), ['secrets', 'versions', 'access', 'latest', '--secret=VAST_API_KEY',
      '--project=cognitum-20260110'], { env: { ...process.env, PATH: pathEnv }, timeout: 60_000, maxBuffer: 65536 },
    (err, stdout) => {
      const key = String(stdout ?? '').trim();
      if (err || !/^[\x21-\x7e]{16,512}$/.test(key)) reject(new Error('VAST_API_KEY fetch from Secret Manager failed'));
      else resolve(key);
    });
  });
}
const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

export class VastError extends Error {
  /** kind: refused | http | transport | parse | rejected */
  constructor(op, kind, detail = '', status = null) {
    super(`vastai ${op}: ${kind}${status ? ` ${status}` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'VastError'; this.op = op; this.kind = kind; this.status = status;
  }
}

/** Strip known secret shapes and every literal secret from a string. */
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const sec of secrets) if (typeof sec === 'string' && sec.length >= 8) s = s.split(sec).join('[REDACTED]');
  return s
    .replace(/(["']?(?:instance_api_key|api_key|jupyter_token)["']?\s*[:=]\s*)["']?[^"',\s}]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(/hf_[A-Za-z0-9]{8,}/g, 'hf_[REDACTED]');
}

/** Resolve a bare command name against an explicit PATH (no reliance on libuv's lookup rules). */
export function resolveBin(name, pathEnv) {
  if (name.includes('/')) return name;
  for (const dir of String(pathEnv ?? '').split(':').filter(Boolean)) {
    const p = path.join(dir, name);
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  throw new VastError('resolve', 'refused', `${name} not found on PATH`);
}

/** The CLI's --raw error object on stderr (one line in v1.6.0; whole-text and regex fallbacks for safety). */
function errorPayload(stderr) {
  const text = String(stderr);
  for (const t of [text.trim(), ...text.split('\n').map(l => l.trim())]) {
    if (!t.startsWith('{')) continue;
    try { const o = JSON.parse(t); if (o && o.error === true) return o; } catch { /* not JSON */ }
  }
  if (/"error"\s*:\s*true/.test(text)) return { error: true, status_code: Number(/"status_code"\s*:\s*(\d+)/.exec(text)?.[1]) || 0, msg: '' };
  return null;
}

/** Parse `ports` from a show-instance row (string or object) -> SSH host port, or null. */
export function parseSshPort(ports) {
  let p = ports;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return null; } }
  const list = p && typeof p === 'object' ? p['22/tcp'] : null;
  if (!Array.isArray(list)) return null;
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const ipOk = e.HostIp === undefined || /^\d{1,3}(\.\d{1,3}){3}$/.test(String(e.HostIp));
    const n = Number(e.HostPort);
    if (ipOk && /^\d{1,5}$/.test(String(e.HostPort)) && Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  }
  return null;
}

/** `{host, port}` for direct SSH, or null if the row does not expose one yet. */
export function parseSshEndpoint(row) {
  if (!row || typeof row.public_ipaddr !== 'string') return null;
  const host = row.public_ipaddr.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.split('.').some(o => Number(o) > 255)) return null;
  const port = parseSshPort(row.ports);
  return port ? { host, port } : null;
}

/** Safe subset of a show-instance row: never jupyter_token, onstart, extra_env, ssh keys. */
export function pickRow(row) {
  return {
    id: row.id, actual_status: row.actual_status ?? null, intended_status: row.intended_status ?? null,
    label: typeof row.label === 'string' ? row.label : null,
    dph_total: row.dph_total, public_ipaddr: row.public_ipaddr ?? null, ports: row.ports ?? null,
  };
}

/**
 * @param {object} o
 * @param {string} o.key            Vast API key (held only in this closure and the child env)
 * @param {string} [o.bin]          default 'vastai', resolved against o.pathEnv
 * @param {string} [o.pathEnv]      PATH for resolution and the child
 * @param {string} [o.home]
 * @param {string} [o.url]          tests only: http://127.0.0.1:PORT (or localhost)
 * @param {number} [o.timeoutMs]
 */
export function makeVastCli({ key, bin = 'vastai', pathEnv = process.env.PATH, home = process.env.HOME,
  url, timeoutMs = 300_000 } = {}) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(key)) throw new VastError('init', 'refused', 'malformed API key');
  if (url !== undefined && !LOCAL_URL.test(url)) throw new VastError('init', 'refused', 'url override must be a local fake');
  const exe = resolveBin(bin, pathEnv);
  const env = { PATH: pathEnv, HOME: home, VASTAI_NO_UPDATE_CHECK: '1', VAST_API_KEY: key, LANG: 'C.UTF-8' };
  const clean = (s) => redact(String(s).slice(0, 300), [key]);

  /** -> { stdout, stderr, code } after argv/secret guards; never rejects on non-zero exit. */
  function exec(op, args) {
    for (const a of args) if (FORBIDDEN.has(String(a).split('=')[0])) throw new VastError(op, 'refused', `forbidden flag ${a}`);
    const argv = [...args, '--raw', ...(url ? ['--url', url] : [])];
    return new Promise((resolve) => {
      const child = spawn(exe, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', d => { if (stdout.length < 4e6) stdout += d; });
      child.stderr.on('data', d => { if (stderr.length < 1e5) stderr += d; });
      child.on('error', () => { clearTimeout(t); resolve({ stdout: '', stderr: '', code: -1 }); });
      child.on('close', (code) => { clearTimeout(t); resolve({ stdout, stderr, code }); });
    });
  }

  /** Run and parse JSON stdout. Throws VastError (http | transport | parse). */
  async function json(op, args, { allowEmpty = false } = {}) {
    const r = await exec(op, args);
    const err = errorPayload(r.stderr);
    if (err) throw new VastError(op, 'http', clean(err.msg ?? ''), Number(err.status_code) || 0);
    if (r.code !== 0) throw new VastError(op, 'transport', `exit ${r.code}`);
    const out = r.stdout.trim();
    if (!out) { if (allowEmpty) return null; throw new VastError(op, 'parse', 'empty stdout'); }
    try { return JSON.parse(out); } catch { throw new VastError(op, 'parse', 'stdout is not JSON'); }
  }

  return {
    async showUser() {
      const u = await json('show user', ['show', 'user']);
      return { credit: u && typeof u === 'object' ? u.credit : undefined };
    },
    async searchOffers(query, { storageGb, limit = 20 }) {
      const rows = await json('search offers', ['search', 'offers', query, '-o', 'dph', '--storage', String(storageGb), '--limit', String(limit)]);
      if (!Array.isArray(rows)) throw new VastError('search offers', 'parse', 'expected an array');
      return rows;
    },
    /** -> instance id. Throws VastError with .definite=true when Vast certainly created nothing. */
    async createInstance(offerId, { image, diskGb, label, onstartCmd }) {
      const op = 'create instance';
      let parsed;
      try {
        parsed = await json(op, ['create', 'instance', String(offerId), '--image', image, '--disk', String(diskGb),
          '--label', label, '--ssh', '--direct', '--cancel-unavail', '--onstart-cmd', onstartCmd]);
      } catch (e) {
        e.definite = e.kind === 'http' && e.status >= 400 && e.status < 500; // 5xx/transport: maybe created
        throw e;
      }
      const success = parsed && parsed.success === true;
      const id = parsed ? parsed.new_contract : undefined;
      parsed = null; // drop instance_api_key
      if (!success) { const e = new VastError(op, 'rejected', 'success != true'); e.definite = true; throw e; }
      if (!Number.isSafeInteger(id) || id <= 0) { const e = new VastError(op, 'parse', 'no valid new_contract'); e.definite = false; throw e; }
      return id;
    },
    /** attach prints a Python repr even with --raw, so this does not JSON.parse. */
    async attachSsh(id, pubKeyPath) {
      const r = await exec('attach ssh', ['attach', 'ssh', String(id), pubKeyPath]);
      const err = errorPayload(r.stderr);
      if (err) throw new VastError('attach ssh', 'http', clean(err.msg ?? ''), Number(err.status_code) || 0);
      if (r.code !== 0) throw new VastError('attach ssh', 'transport', `exit ${r.code}`);
      if (!/['"]success['"]\s*:\s*(True|true)\b/.test(r.stdout)) throw new VastError('attach ssh', 'rejected', 'no success flag');
      return true;
    },
    /** -> safe row subset, or null when the instance is gone (`{"instances": null}`). */
    async showInstance(id) {
      const o = await json('show instance', ['show', 'instance', String(id)]);
      if (o && typeof o === 'object' && Object.hasOwn(o, 'instances') && o.instances === null) return null;
      const row = o && typeof o === 'object' && o.instances && typeof o.instances === 'object' ? o.instances : o;
      if (!row || typeof row !== 'object' || Number(row.id) !== Number(id)) throw new VastError('show instance', 'parse', 'unexpected row');
      return pickRow(row);
    },
    /** Rows whose label is exactly `label` (the CLI filters server side; re-checked here). */
    async showInstancesByLabel(label) {
      const rows = await json('show instances', ['show', 'instances', '--label', label]);
      if (!Array.isArray(rows)) throw new VastError('show instances', 'parse', 'expected an array');
      return rows.filter(r => r && r.label === label && Number.isSafeInteger(r.id) && r.id > 0).map(pickRow);
    },
    /** One destroy request. Empty stdout is normal; confirmation is the caller's job. */
    async destroyOnce(id) {
      await json('destroy instance', ['destroy', 'instance', String(id), '-y'], { allowEmpty: true });
    },
  };
}
