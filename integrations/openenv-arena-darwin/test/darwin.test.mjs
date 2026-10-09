// Darwin driver tests. Mock/stub evaluators only: nothing here touches a model,
// a runner or a GPU, and no score in here is evidence about the real arena.
// Run: node --experimental-strip-types --test integrations/openenv-arena-darwin/test/darwin.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOneParamEvolve, redactArgv, runDarwin } from '../run-darwin.mjs';
import { mutateGenome, oneParamMutationCalls, oneParamViolations, upstreamMutateGenome } from '../lib/one-param-mutator.mjs';
import { makeBudgetedEvaluator } from '../lib/run-budget.mjs';
import * as cells from '../lib/cells.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CELLS_PATH = join(ROOT, 'lib', 'cells.mjs');
const FAKE_EVALUATOR = join(ROOT, 'test', 'stubs', 'fake-evaluator.mjs');
const tmp = [];
const workDir = () => { const d = mkdtempSync(join(tmpdir(), 'arena-darwin-')); tmp.push(d); return join(d, 'work'); };
test.after(() => tmp.forEach(d => rmSync(d, { recursive: true, force: true })));

const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const changedKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]);

test('lib/cells.mjs genome spec and baseline agree', () => {
  const spec = cells.genomeSpec();
  assert.equal(Object.keys(spec).length, cells.FAMILIES.length * 2);
  assert.deepEqual(Object.keys(cells.baselineGenome()).sort(), Object.keys(spec).sort());
});

test('upstream mutateGenome perturbs many params at once (why the one-param shim exists)', () => {
  const spec = cells.genomeSpec();
  const { mutatedParams } = upstreamMutateGenome(cells.baselineGenome(), spec, 0, 1, 0, 0.2);
  assert.ok(mutatedParams.length > 1, `upstream changed ${mutatedParams.length} params`);
});

test('one-param mutateGenome: exactly one param changes, deterministic, in bounds', () => {
  const spec = cells.genomeSpec();
  const parent = cells.baselineGenome();
  const seen = new Set();
  const dirs = new Set();
  for (let seed = 0; seed < 5; seed++) for (let gen = 1; gen <= 4; gen++) for (let i = 0; i < 8; i++) {
    const a = mutateGenome(parent, spec, seed, gen, i, 0.2);
    assert.deepEqual(a, mutateGenome(parent, spec, seed, gen, i, 0.2), 'deterministic');
    const diff = changedKeys(a.genome, parent);
    assert.equal(diff.length, 1);
    assert.deepEqual(a.mutatedParams, diff);
    const [k] = diff;
    assert.ok(a.genome[k] >= spec[k].min && a.genome[k] <= spec[k].max && Number.isInteger(a.genome[k]));
    seen.add(k);
    dirs.add(`${k.split('.')[1]}:${Math.sign(a.genome[k] - parent[k])}`);
  }
  assert.ok(seen.size >= 8, 'round-robin covers many params');
  // Direction must not be locked to the param kind (regression: FNV low-bit parity bug).
  for (const d of ['difficulty:1', 'difficulty:-1', 'budget:1', 'budget:-1']) assert.ok(dirs.has(d), `missing move ${d}`);
});

test('one-param mutateGenome flips at a bound and skips pinned params', () => {
  const spec = { a: { min: 1, max: 3, scale: 'linear', type: 'int' }, b: { min: 5, max: 5, scale: 'linear', type: 'int' } };
  for (let i = 0; i < 6; i++) {
    const r = mutateGenome({ a: 3, b: 5 }, spec, 1, 1, i, 0.2);
    assert.deepEqual(r.genome, { a: 2, b: 5 });
    assert.deepEqual(r.mutatedParams, ['a']);
  }
  const pinned = { b: spec.b };
  assert.deepEqual(mutateGenome({ b: 5 }, pinned, 0, 1, 0, 0.2).mutatedParams, []);
});

test('oneParamViolations flags multi-param and unrecorded children', () => {
  const rec = (id, parentId, genome, mutatedParams) => ({ variant: { id, parentId, genome, mutatedParams }, score: null, children: [] });
  const records = [rec('baseline', null, { x: 1, y: 1 }, []), rec('g1_v0', 'baseline', { x: 2, y: 1 }, ['x']),
    rec('g1_v1', 'baseline', { x: 2, y: 2 }, ['x', 'y']), rec('g1_v2', 'baseline', { x: 1, y: 2 }, ['x'])];
  const v = oneParamViolations(records);
  assert.equal(v.length, 2);
  assert.match(v[0], /^g1_v1:/);
  assert.match(v[1], /^g1_v2:/);
});

test('mock evolution 2 generations x 3 children: archive/winner shape, one param per child', async () => {
  const workRoot = workDir();
  const before = oneParamMutationCalls();
  const report = await runDarwin({ mock: true, workRoot, generations: 2, children: 3, seed: 4, cellsModule: CELLS_PATH });
  const records = readJson(join(workRoot, 'archive.json'));
  const byId = new Map(records.map(r => [r.variant.id, r]));
  const base = byId.get('baseline');
  assert.equal(base.variant.parentId, null);
  assert.deepEqual(base.variant.genome, cells.baselineGenome());
  const kids = records.filter(r => r.variant.parentId !== null);
  const gen1 = kids.filter(r => r.variant.generation === 1);
  const gen2 = kids.filter(r => r.variant.generation === 2);
  assert.equal(gen1.length, 3);
  assert.ok(gen2.length === 3 || gen2.length === 6, `gen2 has ${gen2.length} children`);
  assert.equal(oneParamMutationCalls() - before, kids.length, 'every child came from the one-param shim');
  for (const r of kids) {
    assert.match(r.variant.id, /^g[12]_v\d+$/);
    const parent = byId.get(r.variant.parentId);
    assert.ok(parent, `${r.variant.id} has its parent in the archive`);
    const diff = changedKeys(r.variant.genome, parent.variant.genome);
    assert.equal(diff.length, 1, `${r.variant.id} changed ${diff}`);
    assert.deepEqual(r.variant.mutatedParams, diff);
    for (const f of ['primary', 'noopRate', 'costPerWin']) assert.ok(Number.isFinite(r.score[f]), `${r.variant.id}.${f}`);
    assert.equal(r.score.regressed, false);
  }
  assert.equal(report.oneParamInvariant.ok, true);
  assert.equal(report.mode, 'mock');
  assert.equal(report.evidence, 'synthetic_toy_landscape_not_model_rollouts');
  const best = Math.max(...records.map(r => r.score.primary));
  assert.ok(report.winner, 'winner selected');
  assert.equal(report.winner.score.primary, best);
  assert.ok(report.winner.score.primary >= base.score.primary);
  assert.equal(report.winner.improvedOverBaseline, true, 'seed 4 toy landscape has improving single moves');
  assert.equal(report.winner.lineage[0], 'baseline');
  assert.equal(report.children.length, kids.length);
  for (const c of report.children) assert.ok(c.param && c.from !== c.to);
  const confirmFiles = ['confirmBaselineScorecard', 'confirmWinnerScorecard', 'confirmPaired'];
  for (const [k, f] of Object.entries(report.files)) assert.equal(existsSync(f), !confirmFiles.includes(k), `${k}: ${f}`);
  assert.equal(report.confirmation.status, 'skipped');
  assert.match(report.confirmation.reason, /mock .*never gate-admissible/);
  assert.equal(report.selection.mock, true);
  const wg = readJson(report.files.winnerGenome);
  assert.deepEqual(wg.genome, byId.get(report.winner.variantId).variant.genome);
  assert.equal(wg.cells.length, cells.FAMILIES.length);
  assert.equal(readJson(report.files.winnerScorecard).primary, best);
  assert.equal(readJson(report.files.engineWinner).variant.id, report.engineWinnerId);
  await assert.rejects(runDarwin({ mock: true, workRoot, generations: 1, children: 1, cellsModule: CELLS_PATH }), /already holds an archive/);
});

test('CLI --mock end to end prints a summary and exits 0', () => {
  const workRoot = workDir();
  const out = execFileSync(process.execPath, ['--experimental-strip-types', join(ROOT, 'run-darwin.mjs'), '--mock',
    '--work-root', workRoot, '--generations', '2', '--children', '3', '--seed', '4', '--cells-module', CELLS_PATH],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(out, /one-param invariant: ok/);
  assert.match(out, /NOTE: synthetic_toy_landscape_not_model_rollouts/);
  assert.ok(existsSync(join(workRoot, 'reports', 'darwin-run.json')));
});

test('run budget: refuses candidates past --max-total-new-cells, fail closed', async () => {
  const workRoot = workDir();
  const report = await runDarwin({ mock: true, workRoot, generations: 2, children: 3, seed: 4,
    maxTotalNewCells: cells.FAMILIES.length + 2, cellsModule: CELLS_PATH });
  assert.ok(report.budget.reservedNewCells <= cells.FAMILIES.length + 2);
  assert.ok(report.budget.refusedEvaluations >= 1);
  const refused = report.children.filter(c => /max_total_new_cells_exceeded/.test(c.score.evaluatorError ?? ''));
  assert.equal(refused.length, report.budget.refusedEvaluations);
  for (const c of refused) assert.equal(c.score.regressed, true);
  assert.ok(!refused.some(c => c.id === report.winner.variantId));
  assert.equal(report.oneParamInvariant.ok, true);
});

test('budgeted evaluator: in-flight cells are reserved once and waited on, not run twice', async () => {
  const starts = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const ev = makeBudgetedEvaluator({ genomeToCells: g => Object.keys(g).map(f => ({ family: f, difficulty: g[f], budget: 1, knobs: {} })),
    maxTotalNewCells: 3, run: async (g, id, allowance) => { starts.push([id, allowance]); if (id === 'a') await gate;
      return { variantId: id, primary: 1, regressed: false, noopRate: 0, costPerWin: 1 }; } });
  const a = ev.evaluate({ x: 1, y: 1 }, 'a');
  const b = ev.evaluate({ x: 1, y: 2 }, 'b'); // shares cell x=1 with a, adds y=2
  const c = ev.evaluate({ x: 2, y: 2 }, 'c'); // would need x=2: 4 > 3 -> refused
  await new Promise(r => setImmediate(r));
  assert.deepEqual(starts, [['a', 2]], 'b waits for a (shared in-flight cell)');
  release();
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.deepEqual(starts, [['a', 2], ['b', 1]]);
  assert.equal(ra.regressed || rb.regressed, false);
  assert.equal(rc.regressed, true);
  assert.match(rc.evaluatorError, /max_total_new_cells_exceeded/);
  assert.deepEqual(ev.stats().reservedNewCells, 3);
  const bad = makeBudgetedEvaluator({ genomeToCells: () => [{ family: 'f', difficulty: 1, budget: 1, knobs: {} }], maxTotalNewCells: 9,
    run: async id => ({ variantId: id, primary: NaN, regressed: false, noopRate: 0, costPerWin: 0 }) });
  const card = await bad.evaluate({}, 'n');
  assert.equal(card.regressed, true);
  assert.match(card.evaluatorError, /non_finite/);
});

test('ShellEvaluator path: per-evaluation --max-new-cells allowance and flag passthrough', async () => {
  const workRoot = workDir();
  const log = join(dirname(workRoot), 'calls.jsonl');
  const report = await runDarwin({ workRoot, generations: 1, children: 3, seed: 4, maxTotalNewCells: 50, cellsModule: CELLS_PATH,
    evaluator: FAKE_EVALUATOR, confirmAttempts: 0, passthrough: ['--cells', CELLS_PATH, '--log', log, '--dry-run'] });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.find(c => c.variantId === 'baseline').maxNewCells, cells.FAMILIES.length);
  for (const c of calls.filter(c => c.variantId !== 'baseline')) assert.equal(c.maxNewCells, 1, 'a one-param child adds one cell');
  assert.ok(calls.every(c => c.dryRun));
  for (const c of calls) {
    const at = f => c.argv[c.argv.indexOf(f) + 1];
    assert.deepEqual([at('--seed-base'), at('--attempts')], ['700000', '8'], 'driver owns the seed plan');
    assert.ok(Number(at('--deadline-ms')) < 24 * 3600 * 1000, 'evaluator deadline sits under the ShellEvaluator timeout');
  }
  assert.equal(report.mode, 'evaluator');
  assert.equal(report.oneParamInvariant.ok, true);
  assert.equal(report.budget.reservedNewCells, 2 * (cells.FAMILIES.length + 3), 'unit = runner call: 8 attempts = 2 per cell');
  assert.equal(report.confirmation.reason, '--confirm-attempts 0');
});

test('ShellEvaluator path: cache hits reported by the evaluator are refunded to the run budget', async () => {
  const workRoot = workDir();
  const log = join(dirname(workRoot), 'calls.jsonl');
  const report = await runDarwin({ workRoot, generations: 1, children: 3, seed: 4, maxTotalNewCells: cells.FAMILIES.length, attempts: 4,
    confirmAttempts: 0, cellsModule: CELLS_PATH, evaluator: FAKE_EVALUATOR, passthrough: ['--cells', CELLS_PATH, '--log', log, '--attempted', '0'] });
  assert.equal(report.budget.refusedEvaluations, 0, 'without the refund every child would be refused');
  assert.equal(report.budget.reservedNewCells, 0);
  assert.equal(report.budget.reportedAttemptedNewCells, 0);
});

test('ShellEvaluator path: evaluator fail-closed cards keep their evaluatorError and are never selected', async () => {
  const workRoot = workDir();
  const log = join(dirname(workRoot), 'calls.jsonl');
  const err = await runDarwin({ workRoot, generations: 1, children: 2, maxTotalNewCells: 50, cellsModule: CELLS_PATH,
    evaluator: FAKE_EVALUATOR, passthrough: ['--cells', CELLS_PATH, '--log', log, '--mode', 'failclosed'] }).catch(e => e);
  assert.match(err.message, /^baseline_regressed: stub_refusal/);
  const report = err.report;
  const records = readJson(join(workRoot, 'archive.json'));
  assert.equal(records.find(r => r.variant.id === 'baseline').score.evaluatorError, 'stub_refusal');
  assert.ok(records.filter(r => r.variant.id !== 'baseline').every(r => r.score.evaluatorError === 'baseline_regressed: run aborted, child not evaluated'));
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'only the baseline reached the evaluator: no GPU for children');
  assert.equal(report.winner, null);
  assert.ok(!existsSync(report.files.winnerScorecard) && !existsSync(report.files.winnerGenome));
});

test('ShellEvaluator path: out-of-domain scorecards fail closed; nothing is selected', async () => {
  const workRoot = workDir();
  const log = join(dirname(workRoot), 'calls.jsonl');
  const err = await runDarwin({ workRoot, generations: 1, children: 2, maxTotalNewCells: 50, cellsModule: CELLS_PATH,
    evaluator: FAKE_EVALUATOR, passthrough: ['--cells', CELLS_PATH, '--log', log, '--mode', 'bad'] }).catch(e => e);
  const report = err.report;
  assert.match(report.aborted, /baseline_regressed: scorecard_non_finite_or_out_of_domain/);
  assert.equal(report.winner, null);
  assert.equal(report.baseline.score.regressed, true);
  assert.ok(!existsSync(report.files.winnerScorecard));
});

test('--families narrows the genome and the baseline cell reservation', async () => {
  const report = await runDarwin({ mock: true, workRoot: workDir(), generations: 1, children: 2, maxTotalNewCells: 4,
    families: ['math_route', 'security_triage'], cellsModule: CELLS_PATH });
  assert.deepEqual(Object.keys(report.baseline.genome).sort(),
    ['math_route.budget', 'math_route.difficulty', 'security_triage.budget', 'security_triage.difficulty']);
  assert.equal(report.budget.reservedNewCells, 4);
  assert.equal(report.budget.refusedEvaluations, 0);
  await assert.rejects(runDarwin({ mock: true, workRoot: workDir(), families: ['nope'], cellsModule: CELLS_PATH }), /unknown family/);
});

test('guards: evaluator runs need a budget; driver owns --max-new-cells; argv secrets redacted', async () => {
  await assert.rejects(runDarwin({ workRoot: workDir(), cellsModule: CELLS_PATH, evaluator: FAKE_EVALUATOR }), /max-total-new-cells is required/);
  await assert.rejects(runDarwin({ workRoot: workDir(), cellsModule: CELLS_PATH, evaluator: FAKE_EVALUATOR, maxTotalNewCells: 5,
    passthrough: ['--max-new-cells', '99'] }), /owned by the driver/);
  for (const flag of ['--seed-base', '--attempts', '--deadline-ms']) {
    await assert.rejects(runDarwin({ workRoot: workDir(), cellsModule: CELLS_PATH, evaluator: FAKE_EVALUATOR, maxTotalNewCells: 5,
      passthrough: [flag, '4'] }), /owned by the driver/, flag);
  }
  await assert.rejects(runDarwin({ workRoot: workDir(), cellsModule: CELLS_PATH, evaluator: FAKE_EVALUATOR, maxTotalNewCells: 5,
    concurrency: 5, passthrough: ['--concurrency', '4'] }), /exceeds 16 parallel runner calls/);
  await assert.rejects(runDarwin({ workRoot: workDir(), cellsModule: CELLS_PATH, evaluator: FAKE_EVALUATOR, maxTotalNewCells: 5,
    seedBase: 1000, attempts: 8, confirmSeedBase: 1004 }), /disjoint from the search seeds/);
  assert.deepEqual(redactArgv(['--api-key', 's3cret', '--auth-token=abc', '--base-url', 'http://x']),
    ['--api-key', '<redacted>', '--auth-token=<redacted>', '--base-url', 'http://x']);
  assert.equal(typeof await loadOneParamEvolve(), 'function');
});
