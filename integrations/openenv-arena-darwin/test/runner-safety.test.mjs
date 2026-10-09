// Process-group cleanup, the evaluator deadline, cross-process lock reclaim, and the REAL calibrate.py exit-0-with-
// infra-rows path. Every "server" here is a loopback stub in this process: no model, no GPU, no external network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVALUATOR = join(ROOT, 'evaluator.mjs');
const V2 = process.env.DARWIN_ARENA_ENV_DIR ?? '/home/ruvultra/projects/metaharness-arena-v3/integrations/openenv-arena';
const VENV_PY = process.env.DARWIN_ARENA_PYTHON ?? '/tmp/arena383venv/bin/python';
const TOKENIZER = process.env.DARWIN_ARENA_TOKENIZER_JSON
  ?? '/home/ruvultra/.cache/claude-code/tmp/claude-1000/-home-ruvultra-metaharness/fdc9c3bf-0e2e-4419-9363-e2abdaffd1c5/scratchpad/tok/tokenizer.json';
const scratch = () => mkdtempSync(join(tmpdir(), 'darwin-safety-'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (cond, ms) => { for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 50))) if (cond()) return true; return cond(); };

/** Loopback OpenAI-compatible stub: /v1/models serves `qwen38`; chat completions answer `chatStatus`. */
async function stubServer(chatStatus = 503) {
  const server = createServer((req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'qwen38', root: 'stub', max_model_len: 32768 }] })); return; }
    req.resume(); res.writeHead(chatStatus, { 'content-type': 'application/json' }); res.end('{"error":"stub"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

/** Fake env dir (tasks.py/environment.py are hashed, not run) + a runner that spawns a grandchild and sleeps. */
function fakeEnv(dir) {
  const envDir = join(dir, 'env'); mkdirSync(join(envDir, 'arena_env'), { recursive: true });
  for (const f of ['tasks.py', 'environment.py']) writeFileSync(join(envDir, 'arena_env', f), '# stub');
  const runner = join(dir, 'sleepy-runner.mjs');
  writeFileSync(runner, `import { spawn } from 'node:child_process'; import { appendFileSync } from 'node:fs';
const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
appendFileSync(process.env.PIDLOG, process.pid + ' ' + kid.pid + '\\n'); setTimeout(() => {}, 60000);\n`);
  return { envDir, runner };
}

function evaluatorCli(dir, server, extra, env = {}) {
  const { envDir, runner } = fakeEnv(dir);
  const genome = {}; for (const f of ['math_route', 'security_triage']) { genome[`${f}.difficulty`] = 2; genome[`${f}.budget`] = 8192; }
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', EVALUATOR, '--env-dir', envDir, '--python', process.execPath,
    '--runner', runner, '--tokenizer-json', runner, '--cache-dir', join(dir, 'cache'), '--max-new-cells', '2', '--concurrency', '2',
    '--base-url', server.url, '--model', 'qwen38', '--model-revision', 'stub', ...extra],
  { env: { ...process.env, ARENA_MODEL_API_KEY: 'x', PIDLOG: join(dir, 'pids.txt'), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(JSON.stringify({ variantId: 'slow', genome }));
  let out = ''; child.stdout.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.on('close', (code) => r({ code, out })));
  const pids = () => (existsSync(join(dir, 'pids.txt')) ? readFileSync(join(dir, 'pids.txt'), 'utf8').trim().split(/\s+/).map(Number) : []);
  return { child, exited, pids };
}

test('--deadline-ms: the evaluator kills its runner process groups (grandchildren too), prints a fail-closed card, leaves no locks', async (t) => {
  const dir = scratch(); const server = await stubServer();
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = evaluatorCli(dir, server, ['--deadline-ms', '1500']);
  assert.ok(await waitFor(() => run.pids().length === 4, 10_000), 'two runners + two grandchildren started');
  const { code, out } = await run.exited;
  const card = JSON.parse(out);
  assert.equal(code, 0);
  assert.match(card.raw.evaluatorError, /^evaluator_deadline_exceeded: 1500ms/);
  assert.equal(card.regressed, true);
  assert.ok(await waitFor(() => run.pids().every((p) => !alive(p)), 5000), `orphans left: ${run.pids().filter(alive)}`);
  assert.deepEqual(readdirSync(join(dir, 'cache')).filter((f) => f.endsWith('.lock') || f.endsWith('.jsonl')), []);
});

test('SIGTERM to the evaluator kills its runner process groups the same way', async (t) => {
  const dir = scratch(); const server = await stubServer();
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = evaluatorCli(dir, server, []);
  assert.ok(await waitFor(() => run.pids().length === 4, 10_000));
  run.child.kill('SIGTERM');
  const { out } = await run.exited;
  assert.match(JSON.parse(out).raw.evaluatorError, /^evaluator_interrupted: SIGTERM/);
  assert.ok(await waitFor(() => run.pids().every((p) => !alive(p)), 5000), `orphans left: ${run.pids().filter(alive)}`);
});

test('stale-lock reclaim admits exactly one of 16 simultaneous contenders', async (t) => {
  const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dead = Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());
  const contender = join(dir, 'contender.mjs');
  writeFileSync(contender, `import { createCache } from ${JSON.stringify(join(ROOT, 'lib', 'cache.mjs'))};
const [d, at] = process.argv.slice(2); const c = createCache(d); while (Date.now() < Number(at)) {}
const r = c.lock('a'.repeat(64)); if (r) { console.log('ACQUIRED'); setTimeout(r, 800); }\n`);
  for (let trial = 0; trial < 3; trial++) {
    const d = join(dir, `t${trial}`); mkdirSync(d);
    writeFileSync(join(d, `${'a'.repeat(64)}.lock`), JSON.stringify({ pid: dead }));
    const at = Date.now() + 1200;
    const outs = await Promise.all(Array.from({ length: 16 }, () => new Promise((r) => {
      const c = spawn(process.execPath, [contender, d, String(at)]); let o = ''; c.stdout.on('data', (x) => { o += x; }); c.on('close', () => r(o));
    })));
    assert.equal(outs.filter((o) => o.includes('ACQUIRED')).length, 1, `trial ${trial}`);
  }
});

const haveRealRunner = existsSync(VENV_PY) && existsSync(join(V2, 'scripts', 'calibrate.py')) && existsSync(TOKENIZER);
test('REAL calibrate.py: provider errors exit 0 with infra rows -> not cached, raw outputs kept in runs/',
  { skip: !haveRealRunner && 'needs the v2 env, its venv python and the pinned tokenizer' }, async (t) => {
    const dir = scratch(); const server = await stubServer(503);
    t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
    const cache = join(dir, 'cache');
    // Async spawn: spawnSync would block this event loop, and with it the loopback stub the evaluator probes.
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', EVALUATOR, '--env-dir', V2, '--python', VENV_PY,
      '--tokenizer-json', TOKENIZER, '--cache-dir', cache, '--max-new-cells', '1', '--cell-timeout-s', '300', '--base-url', server.url,
      '--model', 'qwen38', '--model-revision', 'stub'], { env: { ...process.env, ARENA_MODEL_API_KEY: 'x' } });
    child.stdin.end(JSON.stringify({ variantId: 'r1', genome: { 'math_route.difficulty': 2, 'math_route.budget': 8192 } }));
    let stdout = ''; let stderr = ''; child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
    const status = await new Promise((r) => child.on('close', r));
    assert.equal(status, 0, stderr.slice(-2000));
    const card = JSON.parse(stdout);
    assert.equal(card.regressed, true);
    assert.deepEqual([card.raw.failedCells, card.raw.runnerCalls, card.raw.newCells], [1, 2, 0]);
    assert.match(card.raw.regressedReasons.join(' '), /(infra_episodes_4|orchestration_receipt_unavailable).*nothing cached/);
    assert.deepEqual(readdirSync(cache).filter((f) => f.endsWith('.jsonl')), [], 'nothing cached');
    assert.equal(readdirSync(join(cache, 'runs')).length, 2, 'both runner outputs kept for inspection');
  });
