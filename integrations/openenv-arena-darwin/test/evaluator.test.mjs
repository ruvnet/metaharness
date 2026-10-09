import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ShellEvaluator } from '../../../packages/darwin-mode/dist/numeric-evaluator.js';
import { createCache } from '../lib/cache.mjs';
import { baselineGenome, cellKey, genomeToCells } from '../lib/cells.mjs';
import { evaluateGenome, parseArgs, provenanceFor, runnerArgv } from '../evaluator.mjs';
import { fakeRunnerRows } from '../lib/fake-rows.mjs';

const EVALUATOR = fileURLToPath(new URL('../evaluator.mjs', import.meta.url));
const KEY = 'e'.repeat(64);
const scratch = () => mkdtempSync(join(tmpdir(), 'darwin-arena-'));
const shell = (dir, extra = []) => new ShellEvaluator({
  command: [process.execPath, '--experimental-strip-types', '--no-warnings', EVALUATOR, '--dry-run', '--cache-dir', dir, ...extra],
  timeoutMs: 60_000,
});

test('cache: miss, atomic round trip, no temp residue', (t) => {
  const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = createCache(dir);
  assert.equal(cache.get(KEY), null);
  const rows = [{ type: 'darwin_cell', key: KEY }, { type: 'episode', reward: 1 }];
  cache.put(KEY, rows);
  assert.deepEqual(cache.get(KEY), rows);
  assert.deepEqual(readdirSync(dir), [`${KEY}.jsonl`]);
  cache.put(KEY, rows.slice(0, 1));
  assert.deepEqual(cache.get(KEY), rows.slice(0, 1), 'put replaces');
});

test('cache: keys cannot traverse; corrupt or mislabelled files throw', (t) => {
  const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = createCache(dir);
  for (const bad of ['../etc/passwd', 'A'.repeat(64), 'e'.repeat(63), '', null]) assert.throws(() => cache.get(bad), /invalid cell key/);
  assert.throws(() => cache.put('../x', [{}]), /invalid cell key/);
  assert.throws(() => cache.put(KEY, []), /non-empty/);
  writeFileSync(join(dir, `${KEY}.jsonl`), '{"ok":1}\n{broken\n');
  assert.throws(() => cache.get(KEY), /corrupt row 2/);
  writeFileSync(join(dir, `${KEY}.jsonl`), JSON.stringify({ type: 'darwin_cell', key: 'f'.repeat(64) }) + '\n');
  assert.throws(() => cache.get(KEY), /carries key/);
});

test('cache: lock is exclusive, released, and reclaimed from a dead pid', (t) => {
  const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = createCache(dir);
  const release = cache.lock(KEY);
  assert.equal(typeof release, 'function');
  assert.equal(cache.lock(KEY), null, 'held by this live process');
  release();
  const again = cache.lock(KEY);
  assert.equal(typeof again, 'function');
  again();
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  writeFileSync(join(dir, `${KEY}.lock`), JSON.stringify({ pid: Number(dead.stdout.trim()) }));
  const reclaimed = cache.lock(KEY);
  assert.equal(typeof reclaimed, 'function', 'stale lock from an exited process is reclaimed');
  reclaimed();
});

test('dry-run over the real ShellEvaluator protocol: valid card, cache reuse, deterministic', async (t) => {
  const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await shell(dir).evaluate(baselineGenome(), 'baseline');
  assert.equal(first.evaluatorError, undefined, JSON.stringify(first).slice(0, 400));
  assert.equal(first.variantId, 'baseline');
  assert.equal(first.regressed, false);
  for (const k of ['primary', 'noopRate', 'costPerWin']) assert.ok(Number.isFinite(first[k]), k);
  assert.equal(first.raw.newCells, 8);
  assert.equal(first.raw.dryRun, true);
  assert.equal(first.raw.cells.length, 8);
  assert.ok(first.raw.cells.every((c) => c.n === 4 && c.episodes.every((e) => typeof e.seed === 'number')));
  assert.equal(first.raw.provenance.model, 'dryrun.qwen38', 'fake rows can never share a key with real ones');

  const second = await shell(dir).evaluate(baselineGenome(), 'baseline-again');
  assert.deepEqual([second.raw.newCells, second.raw.cachedCells], [0, 8]);
  assert.equal(second.primary, first.primary);
  assert.deepEqual(second.raw.cells.map((c) => c.key), first.raw.cells.map((c) => c.key));

  const child = await shell(dir).evaluate({ ...baselineGenome(), 'security_triage.budget': 16384 }, 'g1_v0');
  assert.deepEqual([child.raw.newCells, child.raw.cachedCells], [1, 7], 'one-param change => exactly one new cell');
});

test('max-new-cells refuses the whole evaluation before any measurement', async (t) => {
  const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const card = await shell(dir, ['--max-new-cells', '3']).evaluate(baselineGenome(), 'too-big');
  assert.equal(card.regressed, true);
  assert.match(card.raw.evaluatorError, /max_new_cells_exceeded: 8 > 3/);
  assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, 'nothing measured or cached');
});

test('invalid genomes and unsupported knobs fail closed with a reason', async (t) => {
  const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const knob = await shell(dir).evaluate({ ...baselineGenome(), 'math_route.distractors': 2 }, 'knob');
  assert.equal(knob.regressed, true);
  assert.match(knob.raw.evaluatorError, /unsupported knob "distractors"/);
  const range = await shell(dir).evaluate({ ...baselineGenome(), 'math_route.difficulty': 7 }, 'range');
  assert.match(range.raw.evaluatorError, /outside \[1, 3\]/);
  assert.equal(range.primary, -1);
});

test('bad stdin / flags still print a fail-closed card (exit 2)', () => {
  const run = (args, input) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', EVALUATOR, ...args],
    { input, encoding: 'utf8' });
  const notJson = run(['--dry-run', '--cache-dir', tmpdir()], 'nope');
  assert.equal(notJson.status, 2);
  assert.equal(JSON.parse(notJson.stdout).regressed, true);
  const badFlag = run(['--dry-run', '--frobnicate'], '{}');
  assert.equal(badFlag.status, 2);
  assert.match(JSON.parse(badFlag.stdout).raw.evaluatorError, /unknown argument --frobnicate/);
});

const models = (ids, maxLen = 32768) => async () => ({ ok: true, status: 200,
  json: async () => ({ object: 'list', data: ids.map((id) => ({ id, root: `/models/${id}`, max_model_len: maxLen })) }) });
const REAL = ['--cache-dir', '/x', '--env-dir', '/env', '--python', '/py', '--tokenizer-json', '/tok.json'];

test('real mode: --model/--model-revision required; refuses without ARENA_MODEL_API_KEY; runner argv shape', async () => {
  assert.throws(() => parseArgs(REAL, {}), /--model and --model-revision are required/);
  const o = parseArgs([...REAL, '--model', 'qwen38', '--model-revision', '1d4bf0f2'], {});
  assert.equal(o.runner, '/env/scripts/calibrate.py');
  assert.equal(o.cellTimeoutS, 4 * 8 * 900 + 600, 'per runner call: the plan\'s worst case (32 requests x 900 s) + startup');
  await assert.rejects(provenanceFor(o, {}), /ARENA_MODEL_API_KEY is not set/);
  assert.throws(() => parseArgs(['--cache-dir', '/x'], {}), /required without --dry-run/);
  assert.throws(() => parseArgs(['--dry-run', '--cache-dir', '/x', '--attempts', '6'], {}), /multiple of 4/);
  const [cell] = genomeToCells({ 'math_route.difficulty': 3, 'math_route.budget': 12000 });
  assert.deepEqual(runnerArgv(o, cell, 700004, '/out.jsonl'), ['/env/scripts/calibrate.py', '--execute',
    '--base-url', 'http://localhost:8100/v1', '--model', 'qwen38', '--model-revision', '1d4bf0f2', '--task-id', 'math_route',
    '--difficulty', '3', '--max-steps', '8', '--max-tokens', '12000', '--request-timeout', '900', '--max-total-tokens', '2000000',
    '--accounting', 'arena', '--episode-completion-tokens', '12000', '--episode-context-tokens', '16384',
    '--tokenizer-json', '/tok.json', '--tokenizer-sha256', '0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3',
    '--seed', '700004', '--thinking', 'off', '--output', '/out.jsonl']);
});

test('cell key binds the endpoint, the SERVED model and the fixed runner args (proxy vs 27B never collide)', async (t) => {
  const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envDir = join(dir, 'env'); mkdirSync(join(envDir, 'arena_env'), { recursive: true });
  for (const f of ['tasks.py', 'environment.py']) writeFileSync(join(envDir, 'arena_env', f), '# stub');
  const base = ['--cache-dir', dir, '--env-dir', envDir, '--python', '/py', '--tokenizer-json', EVALUATOR, '--runner', EVALUATOR,
    '--model', 'qwen38', '--model-revision', '1d4bf0f2'];
  const env = { ARENA_MODEL_API_KEY: 'x' };
  const [cell] = genomeToCells({ 'math_route.difficulty': 2, 'math_route.budget': 8192 });
  const keyOf = async (args, fetchImpl) => cellKey(cell, (await provenanceFor(parseArgs([...base, ...args], env), env, { fetchImpl })).prov);
  const a100 = await keyOf(['--base-url', 'https://a100.example/v1'], models(['qwen38']));
  const proxy = await keyOf(['--base-url', 'http://localhost:8200/v1'], models(['qwen38']));
  const otherLen = await keyOf(['--base-url', 'https://a100.example/v1'], models(['qwen38'], 8192));
  const moreTokens = await keyOf(['--base-url', 'https://a100.example/v1', '--max-total-tokens', '5000000'], models(['qwen38']));
  assert.equal(new Set([a100, proxy, otherLen, moreTokens]).size, 4, 'every outcome-changing input changes the key');
  assert.equal(await keyOf(['--base-url', 'https://A100.example/v1/'], models(['qwen38'])), a100, 'URL is normalized');
  await assert.rejects(keyOf(['--base-url', 'https://a100.example/v1'], models(['qwen2.5-1.5b'])), /model_not_served/);
  await assert.rejects(keyOf(['--base-url', 'http://10.0.0.5:8000/v1'], models(['qwen38'])), /https without credentials, or loopback/);
  await assert.rejects(keyOf([], async () => { throw new TypeError('fetch failed'); }), /server_unreachable/);
  await assert.rejects(keyOf([], async () => ({ ok: false, status: 401 })), /HTTP 401/);
});

test('in-process evaluateGenome: attempts=8 runs two seed blocks; a failing runner fails closed, caches nothing', async (t) => {
  const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const o = parseArgs(['--dry-run', '--cache-dir', dir, '--attempts', '8'], {});
  const card = await evaluateGenome({ 'math_route.difficulty': 2, 'math_route.budget': 8192 }, 'v8', o);
  assert.deepEqual(card.raw.cells[0].episodes.map((e) => e.seed), [700000, 700001, 700002, 700003, 700004, 700005, 700006, 700007]);
  assert.equal(card.raw.runnerCalls, 2);

  const envDir = join(dir, 'env'); mkdirSync(join(envDir, 'arena_env'), { recursive: true });
  for (const f of ['tasks.py', 'environment.py']) writeFileSync(join(envDir, 'arena_env', f), '# stub');
  const real = parseArgs(['--cache-dir', dir, '--env-dir', envDir, '--python', '/nonexistent/python', '--tokenizer-json', EVALUATOR,
    '--runner', EVALUATOR, '--model', 'qwen38', '--model-revision', '1d4bf0f2'], {});
  process.env.ARENA_MODEL_API_KEY ??= 'test-only-local';
  const genome = { 'math_route.difficulty': 2, 'math_route.budget': 8192 };
  const failed = await evaluateGenome(genome, 'boom', real, { fetchImpl: models(['qwen38']) });
  assert.equal(failed.regressed, true);
  assert.equal(failed.raw.failedCells, 1);
  assert.equal(failed.raw.runnerCalls, 2, 'one retry, then the cell fails');
  assert.match(failed.raw.regressedReasons.join(' '), /spawn failed/);
  const { prov } = await provenanceFor(real, process.env, { fetchImpl: models(['qwen38']) });
  assert.equal(createCache(dir).get(cellKey(genomeToCells(genome)[0], prov)), null);
  const down = await evaluateGenome(genome, 'down', real, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.match(down.raw.evaluatorError, /server_unreachable/);
  assert.deepEqual([down.raw.attemptedNewCells, down.raw.runnerCalls], [0, 0]);
});

test('infra episodes and missing receipts are never cached: one retry, then the cell fails', async (t) => {
  const dir = scratch(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const genome = { 'math_route.difficulty': 2, 'math_route.budget': 8192 };
  const infra = (rows) => rows.map((r) => (r.type === 'episode' && r.attempt === 1
    ? { ...r, reward: 0, solved: false, failure: 'request_timeout', trajectory: { ...r.trajectory, failure: 'request_timeout' } } : r));
  const noReceipt = (rows) => rows.map((r) => (r.type === 'orchestration_receipt' ? { ...r, available: false } : r));
  const run = async (fakeRows, id) => {
    const o = { ...parseArgs(['--dry-run', '--cache-dir', join(dir, id)], {}), fakeRows };
    const card = await evaluateGenome(genome, id, o);
    return { card, files: existsSync(join(dir, id)) ? readdirSync(join(dir, id)).filter((f) => f.endsWith('.jsonl')) : [] };
  };
  const flaky = await run((cell, a) => (a.tryNo === 0 ? infra(fakeRunnerRows(cell, a)) : fakeRunnerRows(cell, a)), 'flaky');
  assert.deepEqual([flaky.card.regressed, flaky.card.raw.runnerCalls, flaky.files.length], [false, 2, 1], 'retry succeeded and was cached');
  assert.equal(flaky.card.raw.infra, 0);
  const stuck = await run((cell, a) => infra(fakeRunnerRows(cell, a)), 'stuck');
  assert.deepEqual([stuck.card.regressed, stuck.card.raw.runnerCalls, stuck.files.length], [true, 2, 0]);
  assert.match(stuck.card.raw.regressedReasons.join(' '), /infra_episodes_1 \(seed 700000\).*nothing cached/);
  const unreceipted = await run((cell, a) => noReceipt(fakeRunnerRows(cell, a)), 'noreceipt');
  assert.deepEqual([unreceipted.card.regressed, unreceipted.files.length], [true, 0]);
  assert.match(unreceipted.card.raw.regressedReasons.join(' '), /orchestration_receipt_unavailable/);
  const refused = await evaluateGenome(baselineGenome(), 'r', parseArgs(['--dry-run', '--cache-dir', join(dir, 'r'), '--max-new-cells', '1'], {}));
  assert.deepEqual([refused.raw.attemptedNewCells, refused.raw.runnerCalls], [0, 0], 'refusal cards let the run budget refund');
});
