// Run: node --test integrations/openenv-arena-darwin/flywheel/test/arena-api.test.mjs
// Arena client + token handling against a local fake arena. The fixture token is random per run and is
// only ever compared in-process (assert.ok on a boolean), so a failing assertion cannot print it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { ARENA_BASE, ArenaError, checkBase, createArenaClient } from '../arena-api.mjs';
import { hfTokenPath, readHfToken, redactText, TokenError } from '../arena-token.mjs';
import { startFakeArena } from './arena-fakes/fake-arena-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../arena-api.mjs');
export const TOKEN = 'hf_' + randomBytes(30).toString('base64url');
const noLeak = v => { const s = typeof v === 'string' ? v : inspect(v, { depth: 8 }) + JSON.stringify(v ?? null); return !s.includes(TOKEN) && !s.includes(TOKEN.slice(3)); };
const home = (content = TOKEN + '\n') => {
  const d = mkdtempSync(join(tmpdir(), 'arena-api-test-'));
  if (content !== null) writeFileSync(join(d, 'token'), content, { mode: 0o600 });
  return d;
};
const envFor = hfHome => ({ HOME: '/nonexistent', HF_HOME: hfHome, HF_TOKEN: 'hf_envVarTokenMustBeIgnored000' });
const client = (fake, hfHome = home(), extra = {}) => createArenaClient({ base: fake.base, env: envFor(hfHome), sleep: async () => {}, ...extra });
const rejects = async (p, check) => { try { await p; } catch (e) { return check(e); } assert.fail('expected rejection'); };
const runCli = (args, env) => new Promise(done => {
  const c = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env } });
  let stdout = '', stderr = '';
  c.stdout.on('data', d => { stdout += d; });
  c.stderr.on('data', d => { stderr += d; });
  c.on('close', code => done({ code, stdout, stderr }));
});

test('token path follows AGENTS.md expansion; HF_TOKEN env is never used', () => {
  assert.equal(hfTokenPath({ HF_TOKEN_PATH: '/a/tok', HF_HOME: '/h' }), '/a/tok');
  assert.equal(hfTokenPath({ HF_HOME: '/h' }), '/h/token');
  assert.equal(hfTokenPath({ HOME: '/u' }), '/u/.cache/huggingface/token');
  const t = readHfToken({ env: envFor(home()) });
  assert.ok(t.authorizationHeader() === 'Bearer ' + TOKEN);
  for (const shown of [JSON.stringify({ t }), String(t), `${t}`, inspect(t), inspect({ nested: { t } })]) assert.ok(noLeak(shown));
  assert.match(JSON.stringify({ t }), /\[REDACTED\]/);
});

test('bad token files fail closed and never echo their content', () => {
  const secretish = 'hf_secret value';
  for (const [content, re] of [[null, /unreadable/], ['', /empty/], [secretish, /invalid format/], ['notatoken12345', /invalid format/], ['hf_a\r\nX-Evil: 1', /invalid format/]]) {
    const err = (() => { try { readHfToken({ env: envFor(home(content)) }); } catch (e) { return e; } })();
    assert.ok(err instanceof TokenError);
    assert.match(err.message, re);
    if (content) assert.ok(!err.message.includes(content.trim()) && !err.message.includes('secret'));
  }
});

test('redactText removes bearer values, authorization headers and hf_ token shapes', () => {
  const s = redactText(`Authorization: Bearer ${TOKEN}\n{"authorization":"Bearer ${TOKEN}"} bearer ${TOKEN} raw ${TOKEN}`, [TOKEN]);
  assert.ok(noLeak(s));
  assert.ok(!/hf_[A-Za-z0-9]{6}/.test(redactText('leaked hf_abcdefghij in text')));
});

test('base URL: official arena or loopback http only', () => {
  assert.equal(checkBase(ARENA_BASE), ARENA_BASE);
  assert.equal(checkBase('http://127.0.0.1:9/api/openenv'), 'http://127.0.0.1:9/api/openenv');
  for (const bad of ['https://evil.example/api/openenv', 'http://10.0.0.5/api/openenv', ARENA_BASE + '/',
    'http://u:p@127.0.0.1:9/api/openenv', 'http://127.0.0.1:9/api/openenv?x=1', 'not a url'])
    assert.throws(() => checkBase(bad), ArenaError);
});

test('public routes never carry the token (and never read it); authenticated routes carry exactly the file token', async () => {
  const fake = await startFakeArena();
  try {
    const anon = client(fake, home(null)); // no token file at all
    assert.equal((await anon.status()).connected, true);
    assert.equal((await anon.leaderboard()).benchmark, 'heldout-v2');
    await rejects(anon.listSubmissions(), e => assert.ok(e instanceof TokenError));
    assert.equal(fake.requests.length, 2, 'the authenticated call failed before any request');
    assert.deepEqual(await client(fake).listSubmissions(), []);
    const [st, lb, sub] = fake.requests;
    assert.equal(st.path, '/api/openenv');
    assert.equal(lb.path, '/api/leaderboard');
    assert.ok(st.headers.authorization === undefined && lb.headers.authorization === undefined);
    assert.ok(sub.headers.authorization === 'Bearer ' + TOKEN, 'file token sent, HF_TOKEN env ignored');
  } finally { await fake.close(); }
});

test('error answers never leak the token: 401 that echoes the header, 500 HTML that echoes it', async () => {
  const fake = await startFakeArena({
    'GET /api/openenv/submissions': r => ({ status: 401, json: { code: 'UNAUTHORIZED', echo: r.headers.authorization } }),
    'GET /api/openenv/runs/r1': r => ({ status: 500, text: `<html>${r.headers.authorization}</html>` }),
  });
  try {
    const c = client(fake, home(), { getRetries: 0 });
    await rejects(c.listSubmissions(), e => {
      assert.ok(e instanceof ArenaError);
      assert.equal(e.status, 401);
      assert.equal(e.code, 'UNAUTHORIZED');
      for (const shown of [e.message, String(e), e.stack, JSON.stringify(e), inspect(e)]) assert.ok(noLeak(shown));
    });
    await rejects(c.getRun('r1'), e => { assert.equal(e.code, 'REQUEST_FAILED'); assert.ok(noLeak(e) && noLeak(e.stack)); });
  } finally { await fake.close(); }
});

test('redirects are refused and never followed (token cannot reach another host)', async () => {
  const target = await startFakeArena();
  const fake = await startFakeArena({ 'GET /api/openenv/submissions': () => ({ status: 302, headers: { Location: target.origin + '/steal' } }) });
  try {
    await rejects(client(fake).listSubmissions(), e => assert.equal(e.code, 'REDIRECT_REFUSED'));
    assert.equal(target.requests.length, 0);
  } finally { await fake.close(); await target.close(); }
});

test('GET retries transient 502/503/504 only; 404 submission is null; bad ids never hit the network', async () => {
  let n = 0;
  const fake = await startFakeArena({
    'GET /api/openenv/submissions': () => (++n < 3 ? { status: n === 1 ? 503 : 504, json: {} } : { status: 200, json: { submissions: [{ state: 'validated' }] } }),
    'GET /api/openenv/runs/r9': () => ({ status: 400, json: { code: 'BAD' } }),
  });
  try {
    const c = client(fake);
    assert.deepEqual(await c.listSubmissions(), [{ state: 'validated' }]);
    assert.equal(n, 3);
    assert.equal(await c.getSubmission('does-not-exist'), null);
    await rejects(c.getRun('r9'), e => assert.equal(e.code, 'BAD'));
    assert.equal(fake.requests.filter(r => r.path === '/api/openenv/runs/r9').length, 1, '4xx is not retried');
    const before = fake.requests.length;
    await rejects(c.getSubmission('../etc/passwd'), e => assert.equal(e.code, 'INVALID_ID'));
    assert.equal(fake.requests.length, before);
  } finally { await fake.close(); }
});

test('oversized and non-JSON bodies are refused', async () => {
  const fake = await startFakeArena({
    'GET /api/openenv/runs/big': () => ({ status: 200, text: 'x'.repeat(3 * 1024 * 1024) }),
    'GET /api/openenv/runs/html': () => ({ status: 200, text: '<html>ok</html>' }),
  });
  try {
    const c = client(fake);
    await rejects(c.getRun('big'), e => assert.equal(e.code, 'RESPONSE_TOO_LARGE'));
    await rejects(c.getRun('html'), e => assert.equal(e.code, 'INVALID_JSON_RESPONSE'));
  } finally { await fake.close(); }
});

test('unexpected submissions-list shape fails closed', async () => {
  const fake = await startFakeArena({ 'GET /api/openenv/submissions': () => ({ status: 200, json: { items: [] } }) });
  try { await rejects(client(fake).listSubmissions(), e => assert.equal(e.code, 'UNEXPECTED_SUBMISSIONS_SHAPE')); } finally { await fake.close(); }
});

test('CLI: public status works without a token; authenticated errors print no token; slot verb', async () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const fake = await startFakeArena({
    'GET /api/openenv/runs/r1': r => ({ status: 401, json: { code: 'UNAUTHORIZED', echo: r.headers.authorization } }),
    'GET /api/openenv/submissions': () => ({ status: 200, json: [{ submission_id: 'a', state: 'validated', slot: { state: 'used' }, accepted_at: (now - 25 * 3600e3) / 1000 }] }),
  });
  try {
    const st = await runCli(['status', '--base', fake.base], { HF_HOME: home(null), HOME: '/nonexistent' });
    assert.equal(st.code, 0);
    assert.equal(JSON.parse(st.stdout).connected, true);
    const h = home();
    const bad = await runCli(['run', '--id', 'r1', '--base', fake.base], { HF_HOME: h, HOME: '/nonexistent' });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /HTTP 401, UNAUTHORIZED/);
    assert.ok(noLeak(bad.stderr) && noLeak(bad.stdout));
    const slot = await runCli(['slot', '--now-ms', String(now), '--base', fake.base], { HF_HOME: h, HOME: '/nonexistent' });
    assert.equal(slot.code, 0);
    assert.equal(JSON.parse(slot.stdout).free, true);
    const noNow = await runCli(['slot', '--base', fake.base], { HF_HOME: h, HOME: '/nonexistent' });
    assert.equal(noNow.code, 2, 'slot without an explicit now fails closed');
    const lb = await runCli(['leaderboard', '--user', 'ruv', '--base', fake.base], { HF_HOME: home(null), HOME: '/nonexistent' });
    assert.equal(JSON.parse(lb.stdout).hasIncumbent, false);
  } finally { await fake.close(); }
});
