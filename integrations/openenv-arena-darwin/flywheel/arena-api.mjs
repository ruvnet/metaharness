#!/usr/bin/env node
// OpenEnv Arena client for the daily flywheel: status, leaderboard, own submissions, one submission, runs,
// the 24h slot, and a receipt-guarded submit. Contract: https://openenvarena-arena.hf.space/AGENTS.md
//
//   node arena-api.mjs status|leaderboard [--user ruv]                  (public, no token)
//   node arena-api.mjs submissions|slot --now-ms N|submission --id ID|run --id ID|events --id ID  (token)
//   [--base http://127.0.0.1:PORT/api/openenv]   (loopback only, for fakes)
//
// There is deliberately no `submit` CLI verb: `client.submit()` is a library call the orchestrator makes
// only after the signed gate, every pre-submit check, a free slot and mode=auto. It mirrors submission.py's
// receipt protocol: preflight GET of the id, persist `sending`, ONE POST, reconcile on an unknown outcome.
// The token is read from the HF token file only (arena-token.mjs) and sent only as an in-process header to
// URLs under the arena base. Redirects are refused. Errors carry an HTTP status and an arena code, never a body.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson, sha256Hex, SHA256_RE } from './canonical-json.mjs';
import { readHfToken, redactText } from './arena-token.mjs';
import { ACCEPTED_AT_FIELDS, slotStatus, userStanding } from './arena-slot.mjs';

export { ACCEPTED_AT_FIELDS, parseTimestampMs, SLOT_WINDOW_MS, slotStatus, userStanding } from './arena-slot.mjs';

export const ARENA_BASE = 'https://openenvarena-arena.hf.space/api/openenv';
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_BODY = 2 * 1024 * 1024;
const CODE_RE = /^[A-Z_]{1,80}$/;
const TRANSIENT = new Set([502, 503, 504]);
const NOTHING_STORED_503 = new Set(['IMAGE_UNAVAILABLE', 'REGISTRY_RATE_LIMITED', 'CAPACITY_BUSY', 'DATASET_UNAVAILABLE']);
const ARENA_STATES = new Set(['validating', 'validated', 'rejected', 'pending', 'accepted']);

export class ArenaError extends Error {
  constructor(status, code, { retryAfterS = null } = {}) {
    const safe = typeof code === 'string' && CODE_RE.test(code) ? code : 'REQUEST_FAILED';
    super(`Arena request failed: HTTP ${status ?? 'unknown'}, ${safe}`);
    Object.assign(this, { name: 'ArenaError', status: status ?? null, code: safe, retryAfterS });
  }
}
export class SubmitError extends Error {}

export function checkBase(base) {
  let u;
  try { u = new URL(base); } catch { throw new ArenaError(null, 'BASE_URL_INVALID'); }
  const loopback = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if ((base !== ARENA_BASE && !loopback) || u.username || u.password || u.search || u.hash || base.endsWith('/'))
    throw new ArenaError(null, 'BASE_URL_REFUSED');
  return base;
}

const pick = (j, k) => [j?.[k], j?.detail?.[k], j?.error?.[k]].find(v => v !== undefined && v !== null);
function retryAfterOf(json, res) {
  const v = pick(json, 'retry_after_s') ?? Number(res.headers.get('retry-after') ?? NaN);
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BODY) { await reader.cancel().catch(() => {}); throw new ArenaError(res.status, 'RESPONSE_TOO_LARGE'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const assertId = id => { if (typeof id !== 'string' || !ID_RE.test(id)) throw new ArenaError(null, 'INVALID_ID'); };
const safeStr = (v, max = 512) => (typeof v === 'string' && v.length <= max ? redactText(v) : null);

/** Keep only what decisions and receipts need; unlike submission.py this keeps images[].resolved. */
export function summarizeSubmission(s, expectedId) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new ArenaError(null, 'INVALID_SUBMISSION_RESPONSE');
  if (expectedId !== undefined && s.submission_id !== undefined && s.submission_id !== expectedId)
    throw new ArenaError(null, 'SUBMISSION_ID_MISMATCH');
  if (!ARENA_STATES.has(s.state)) throw new ArenaError(null, 'INVALID_SUBMISSION_STATE');
  const out = { submission_id: safeStr(s.submission_id) ?? expectedId ?? null, state: s.state };
  if (['held', 'used', 'returned'].includes(s.slot?.state)) out.slot_state = s.slot.state;
  if (['author', 'platform'].includes(s.error_origin)) out.error_origin = s.error_origin;
  if (typeof s.run?.run_id === 'string' && ID_RE.test(s.run.run_id)) out.run_id = s.run.run_id;
  if (safeStr(s.run?.dashboard)) out.dashboard = safeStr(s.run.dashboard);
  for (const f of ACCEPTED_AT_FIELDS) if (typeof s[f] === 'number' || safeStr(s[f], 64)) out[f] = s[f];
  if (Array.isArray(s.images)) out.images = s.images.slice(0, 50).map(i => ({
    submitted: safeStr(i?.submitted ?? i?.image), resolved: safeStr(i?.resolved), compatibility: safeStr(i?.compatibility, 64) }));
  if (s.dataset && typeof s.dataset === 'object') out.dataset = { repo: safeStr(s.dataset.repo), revision: safeStr(s.dataset.revision, 64) };
  if (Array.isArray(s.report?.errors)) out.errors = s.report.errors.slice(0, 20).map(e => safeStr(typeof e === 'string' ? e : e?.code, 80));
  return out;
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dfd = openSync(dirname(path), 'r');
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

async function withLock(path, fn) {
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  try { fd = openSync(path + '.lock', 'wx', 0o600); } catch (e) {
    if (e.code === 'EEXIST') throw new SubmitError('receipt is locked; reconcile the original process first; nothing was sent');
    throw e;
  }
  closeSync(fd);
  try { return await fn(); } finally { unlinkSync(path + '.lock'); }
}

export function createArenaClient({ base = ARENA_BASE, env = process.env, tokenPath, fetchImpl = globalThis.fetch,
  timeoutMs = 30_000, getRetries = 2, sleep = ms => new Promise(r => setTimeout(r, ms)),
  clock = () => new Date().toISOString() } = {}) {
  checkBase(base);
  const origin = new URL(base).origin;
  let token = null;
  const auth = () => (token ??= readHfToken(tokenPath ? { env, path: tokenPath } : { env }));
  const redact = text => (token ? token.redact(text) : redactText(text));

  async function once(url, { method = 'GET', body, authenticated = false } = {}) {
    if (authenticated && !url.startsWith(base + '/')) throw new ArenaError(null, 'AUTH_SCOPE_REFUSED');
    const headers = { Accept: 'application/json', 'User-Agent': 'metaharness-arena-flywheel/1' };
    if (authenticated) headers.Authorization = auth().authorizationHeader();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await fetchImpl(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new ArenaError(null, 'OUTCOME_UNKNOWN'); }
    if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
      await res.body?.cancel().catch(() => {});
      throw new ArenaError(res.status, 'REDIRECT_REFUSED');
    }
    let text;
    try { text = await readCapped(res); } catch (e) { throw e instanceof ArenaError ? e : new ArenaError(res.status, 'OUTCOME_UNKNOWN'); }
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    if (res.status < 200 || res.status >= 300) throw new ArenaError(res.status, pick(json, 'code'), { retryAfterS: retryAfterOf(json, res) });
    if (json === undefined || json === null) throw new ArenaError(res.status, 'INVALID_JSON_RESPONSE');
    return { status: res.status, json };
  }

  async function get(url, authenticated) {
    for (let attempt = 0; ; attempt++) {
      try { return (await once(url, { authenticated })).json; } catch (e) {
        const transient = e instanceof ArenaError && (TRANSIENT.has(e.status) || e.code === 'OUTCOME_UNKNOWN');
        if (!transient || attempt >= getRetries) throw e;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  const client = {
    base, redact,
    async status() { const j = await get(base, false); return { connected: j?.connected === true, raw: j }; },
    leaderboard: () => get(origin + '/api/leaderboard', false),
    async listSubmissions() {
      const j = await get(base + '/submissions', true);
      const list = Array.isArray(j) ? j : Array.isArray(j?.submissions) ? j.submissions : null;
      if (!list) throw new ArenaError(null, 'UNEXPECTED_SUBMISSIONS_SHAPE');
      return list;
    },
    async getSubmission(id) {
      assertId(id);
      try { return await get(base + '/submissions/' + encodeURIComponent(id), true); } catch (e) {
        if (e instanceof ArenaError && e.status === 404) return null;
        throw e;
      }
    },
    getRun(id) { assertId(id); return get(base + '/runs/' + encodeURIComponent(id), true); },
    getRunEvents(id) { assertId(id); return get(base + '/runs/' + encodeURIComponent(id) + '/events', true); },
    async reconcile(receipt, path) {
      try {
        const found = await client.getSubmission(receipt.submission_id);
        receipt.reconciled_at = clock();
        if (found) { receipt.state = 'recorded'; receipt.arena = summarizeSubmission(found, receipt.submission_id); delete receipt.next_action; }
        else if (receipt.state !== 'refused') {
          receipt.state = 'unconfirmed';
          receipt.next_action = 'No submission with this id is visible. Re-check this same id; never mint a new id while the outcome is unknown.';
        }
      } catch (e) {
        if (!(e instanceof ArenaError)) throw e;
        if (receipt.state !== 'refused') { receipt.state = 'unknown'; receipt.next_action = 'Reconcile this same id via GET /submissions/{id}; no retry was sent.'; }
      }
      atomicJson(path, receipt);
      return receipt;
    },
    /** ONE POST of the exact canonical bytes whose sha256 equals approvedSha256. Never retried here. */
    async submit({ request, approvedSha256, receiptPath }) {
      if (typeof approvedSha256 !== 'string' || !SHA256_RE.test(approvedSha256)) throw new SubmitError('approved digest must be 64 lowercase hex');
      if (!request || typeof request !== 'object' || !ID_RE.test(String(request.submission_id))) throw new SubmitError('request has no valid submission_id');
      if (typeof receiptPath !== 'string' || !receiptPath) throw new SubmitError('receiptPath is required');
      const body = canonicalJson(request);
      const sha = sha256Hex(Buffer.from(body, 'utf8'));
      if (sha !== approvedSha256) throw new SubmitError('request bytes differ from the approved digest; nothing was sent');
      const id = request.submission_id;
      return withLock(receiptPath, async () => {
        if (existsSync(receiptPath)) {
          const prior = JSON.parse(readFileSync(receiptPath, 'utf8'));
          if (prior?.submission_id !== id || prior?.request_sha256 !== sha) throw new SubmitError('receipt belongs to a different request; nothing was sent');
          return client.reconcile(prior, receiptPath); // an existing receipt is only ever reconciled, never re-POSTed
        }
        const found = await client.getSubmission(id); // a failure here throws before anything is written or sent
        const receipt = { kind: 'arena_flywheel_submit_receipt', version: 1, submission_id: id, request_sha256: sha,
          created_at: clock(), post_attempted: false, state: 'prepared' };
        if (found) {
          Object.assign(receipt, { state: 'recorded', arena: summarizeSubmission(found, id),
            note: 'An arena submission with this id already exists; its payload digest is not verifiable. No POST sent.' });
          atomicJson(receiptPath, receipt);
          return receipt;
        }
        Object.assign(receipt, { state: 'sending', post_attempted: true });
        atomicJson(receiptPath, receipt); // persisted BEFORE the POST so an interruption never causes a second one
        try {
          const res = await once(base + '/submissions', { method: 'POST', body, authenticated: true });
          if (res.status !== 202) throw new ArenaError(res.status, 'SUBMISSION_RESULT_UNCERTAIN');
          Object.assign(receipt, { arena: summarizeSubmission(res.json, id), state: 'recorded', accepted_at: clock() });
          atomicJson(receiptPath, receipt);
          return receipt;
        } catch (e) {
          if (!(e instanceof ArenaError)) throw e;
          Object.assign(receipt, { http_status: e.status, error_code: e.code });
          const definite = (e.status >= 400 && e.status < 500 && e.status !== 408 && e.code !== 'REQUEST_FAILED')
            || (e.status === 503 && NOTHING_STORED_503.has(e.code));
          if (definite) { // "Refused at once": nothing stored, slot not consumed
            Object.assign(receipt, { state: 'refused', slot_consumed: false });
            if (e.code === 'SUBMISSION_QUOTA_EXCEEDED') Object.assign(receipt, { retry_after_s: e.retryAfterS, quota_observed_at: clock() });
            atomicJson(receiptPath, receipt);
            return receipt;
          }
          receipt.state = 'unknown';
          atomicJson(receiptPath, receipt);
          return client.reconcile(receipt, receiptPath);
        }
      });
    },
  };
  return client;
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    base: { type: 'string' }, id: { type: 'string' }, user: { type: 'string' }, 'now-ms': { type: 'string' } } });
  const verb = positionals[0];
  let out;
  let client = { redact: redactText };
  try {
    client = createArenaClient(values.base ? { base: values.base } : {});
    if (verb === 'status') out = await client.status();
    else if (verb === 'leaderboard') { const b = await client.leaderboard(); out = values.user ? userStanding(b, values.user) : b; }
    else if (verb === 'submissions') out = (await client.listSubmissions()).map(s => summarizeSubmission(s));
    else if (verb === 'slot') out = slotStatus({ submissions: await client.listSubmissions(), nowMs: Number(values['now-ms']) });
    else if (verb === 'submission') out = await client.getSubmission(values.id);
    else if (verb === 'run') out = await client.getRun(values.id);
    else if (verb === 'events') out = await client.getRunEvents(values.id);
    else { process.stderr.write('usage: arena-api.mjs status|leaderboard|submissions|slot|submission|run|events\n'); return 2; }
  } catch (e) {
    process.stderr.write(client.redact(`${e?.name ?? 'Error'}: ${e?.message ?? e}`) + '\n');
    return 2;
  }
  process.stdout.write(client.redact(JSON.stringify(out, null, 2)) + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
