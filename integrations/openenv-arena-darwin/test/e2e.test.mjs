// End-to-end wiring: run-darwin.mjs -> REAL evaluator.mjs (--dry-run fake rows, no model/GPU) -> gate.mjs.
// The scores are a deterministic toy landscape; this proves the modules compose, not that any knob helps.
// The gate runs without a key dir, so it signs with an ephemeral makeSigner() key and persists nothing.
// Run: node --experimental-strip-types --test integrations/openenv-arena-darwin/test/e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDarwin } from '../run-darwin.mjs';
import { verifyGateReceipt } from '../gate.mjs';
import { FAMILIES } from '../lib/cells.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'DARWIN_GATE_KEY_DIR'));
const gate = args => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(ROOT, 'gate.mjs'), ...args],
  { encoding: 'utf8', env });

test('darwin (2 gen x 3 children, real evaluator --dry-run) -> fresh-seed confirmation -> flywheel gate -> signed receipt', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-darwin-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = join(dir, 'cache');
  const report = await runDarwin({ workRoot: join(dir, 'work'), generations: 2, children: 3, seed: 4, maxTotalNewCells: 300,
    confirmAttempts: 64, passthrough: ['--dry-run', '--cache-dir', cache] });

  assert.equal(report.mode, 'evaluator');
  assert.equal(report.evidence, 'evaluator_dry_run_fake_rows_not_model_rollouts');
  assert.equal(report.oneParamInvariant.ok, true);
  assert.equal(report.budget.refusedEvaluations, 0);
  assert.equal(report.budget.reservedNewCells, report.budget.reportedRunnerCalls, 'charged = runner calls actually made');
  assert.deepEqual(report.selection, { seedBase: 700000, attempts: 8, evaluated: report.evaluated, mock: false, baselineRunnerCalls: 16 });
  assert.ok(report.winner.improvedOverBaseline, 'seed 4 finds an improving single move on search data');

  // Confirmation re-measured baseline and winner on disjoint seeds and paired the changed cell's blocks.
  const c = report.confirmation;
  assert.equal(c.status, 'measured');
  assert.deepEqual([c.seedBase, c.attempts, c.changedFamilies.length, c.pairs.total], [800000, 64, 1, 16]);
  const cb = readJson(report.files.confirmBaselineScorecard); const cw = readJson(report.files.confirmWinnerScorecard);
  assert.deepEqual([cb.raw.provenance.seedBase, cb.raw.provenance.attempts], [800000, 64]);
  assert.deepEqual(cw.raw.provenance, cb.raw.provenance, 'same fitness measure: same provenance');
  assert.notEqual(readJson(report.files.baselineScorecard).raw.provenance.seedBase, cb.raw.provenance.seedBase);
  assert.equal(readJson(report.files.confirmPaired).pairedOutcomes.length, 16);

  const keyEnv = {};
  // Default candidate budget = candidates evaluated (Bonferroni over the search): this toy win is not strong enough.
  const strict = gate(['--run', report.files.run, '--out', join(dir, 'strict.json')]);
  assert.equal(strict.status, 1, strict.stderr);
  const so = JSON.parse(strict.stdout);
  assert.equal(so.verified, true);
  assert.equal(so.sequential.threshold, 20 * report.evaluated);
  assert.ok(so.reasons.some(r => r.startsWith('insufficient_sequential_evidence')), so.reasons.join(','));
  // The search scorecards are refused outright: they are the data the winner was selected on.
  const search = gate(['--run', report.files.run, '--baseline', report.files.baselineScorecard, '--candidate', report.files.winnerScorecard,
    '--out', join(dir, 'search.json')]);
  assert.equal(search.status, 1);
  assert.ok(JSON.parse(search.stdout).reasons.includes('selection_seed_reused'));
  // An operator may gate the ONE pre-specified fresh-holdout comparison at candidate budget 1; it is recorded in the receipt.
  const receiptPath = join(dir, 'receipt.json');
  const r = gate(['--run', report.files.run, '--candidate-budget', '1', '--out', receiptPath], keyEnv);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.promote, out.verified, out.reasons], [true, true, []]);
  assert.ok(out.sequential.eValue >= 20 && out.deltas.primary > 0 && out.deltas.costPerWin <= 0);
  const receipt = readJson(receiptPath);
  assert.equal(receipt.payload.candidate.variantId, 'confirm-winner');
  assert.equal(receipt.payload.config.candidateBudgetSource, 'explicit');
  assert.deepEqual(receipt.payload.selection, { seedBase: 700000, attempts: 8, evaluated: report.evaluated });
  assert.ok(verifyGateReceipt(receipt, { expectedPublicKey: out.publicKey }));
  assert.equal(gate(['--verify', receiptPath, '--expect-public-key', out.publicKey]).status, 0);
  assert.equal(gate(['--verify', receiptPath]).status, 2, 'unpinned verification fails closed');
  assert.equal(readdirSync(cache).filter(f => f.endsWith('.jsonl')).length, report.budget.reportedAttemptedNewCells);
});
