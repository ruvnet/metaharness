// End-to-end through the REAL Darwin lane via darwin-steps.mjs: run-darwin.mjs (cells-module wrapper with the
// incumbent as baseline) -> evaluator.mjs --dry-run for the preregistered confirmation -> gate.mjs --paired with a
// pinned key in a temp dir. Arena, render-and-check and the GPU are fakes. Dry-run rows are a toy landscape, so
// the run MUST end blocked (darwinEvidenceIsScorecards / confirmationNotDryRun false) even in auto mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFlywheel } from '../flywheel.mjs';
import { makeDarwinSteps } from '../darwin-steps.mjs';
import { fileSigner, verifyGateReceipt } from '../../gate.mjs';
import { makeFakes, setup, START } from './fw-fakes.mjs';

async function smokeRun(t, seed) {
  const keyDir = mkdtempSync(join(tmpdir(), 'fw-smoke-key-'));
  const env = setup({ darwin: { generations: 2, children: 3, concurrency: 2, maxTotalNewCells: 20, seed, searchSeedBase: 700000,
    searchAttempts: 4, evaluatorTimeoutMs: 120_000, searchTimeoutMs: 240_000, gpuDeadlineMarginMs: 0 } });
  t.after(() => { rmSync(env.home, { recursive: true, force: true }); rmSync(keyDir, { recursive: true, force: true }); });
  env.config.mode = 'auto'; // the --mode flag alone can only downgrade
  env.config.evaluator.dryRun = true;
  env.config.evaluator.cacheDir = join(env.home, 'cache');
  env.config.gate.keyDir = keyDir;
  env.config.gate.expectPublicKey = fileSigner(keyDir).publicKey();
  const fakes = makeFakes();
  fakes.deps.darwin = await makeDarwinSteps(env.config, { env: { PATH: process.env.PATH, HOME: env.home } });
  const st = await runFlywheel({ config: env.config, date: '2026-10-09', now: START, mode: 'auto', stateDir: env.stateDir, deps: fakes.deps });
  return { st, env, fakes };
}

test('real run-darwin + evaluator --dry-run + gate.mjs: wired correctly, verified, and blocked as dry-run evidence', { timeout: 600_000 }, async (t) => {
  // The dry-run landscape is the Darwin lane's toy (it changes with lib/fitness.mjs); find a search seed with an improver.
  let run = null;
  for (const seed of [6, ...Array.from({ length: 24 }, (_, i) => i)]) {
    run = await smokeRun(t, seed);
    assert.equal(run.st.error, undefined, run.st.error);
    assert.equal(run.fakes.calls.up.length, 0, 'dry-run evaluator: no GPU rented');
    if (run.st.candidate) break;
    assert.equal(run.st.outcome, 'needs-human', 'day 1 without an improver renders the v2 defaults for a human');
  }
  const { st, env, fakes } = run;
  assert.equal(st.darwin.evidence, 'evaluator_dry_run_fake_rows_not_model_rollouts');
  assert.ok(st.candidate, 'some search seed finds a one-param improvement in the dry-run landscape');

  // Confirmation: both arms on the same fresh block, identical provenance equal to the preregistered plan.
  const runDir = join(env.stateDir, 'runs', '2026-10-09');
  const inc = JSON.parse(readFileSync(join(runDir, 'confirm', 'incumbent-card.json'), 'utf8'));
  const cand = JSON.parse(readFileSync(join(runDir, 'confirm', 'candidate-card.json'), 'utf8'));
  assert.deepEqual(inc.raw.provenance, cand.raw.provenance);
  assert.equal(inc.raw.provenance.seedBase, 2_028_100);
  assert.equal(inc.raw.provenance.attempts, 8);
  assert.equal(st.confirmation.provenanceMatchesPlan, true);
  assert.equal(st.confirmation.cardsMatchGenomes, true);
  assert.equal(st.confirmation.preregistered, true);
  // Darwin pairing (= gate.mjs v2's own): one item per 4-seed block of each CHANGED cell.
  assert.equal(st.confirmation.pairedCount, st.candidate.changedFamilies.length * 2);
  assert.equal(st.confirmation.candidateBudget, JSON.parse(readFileSync(st.darwin.reportPath, 'utf8')).selection.evaluated);
  const searchReport = JSON.parse(readFileSync(st.darwin.reportPath, 'utf8'));
  assert.equal(searchReport.confirmation.status, 'skipped', 'run-darwin confirmation off: the flywheel confirmation replaces it');
  assert.deepEqual([searchReport.selection.seedBase, searchReport.selection.attempts], [700000, 4]);

  // The real gate ran on those cards with the paired file; the receipt verifies against the pinned key.
  const receipt = JSON.parse(readFileSync(st.gate.receiptPath, 'utf8'));
  assert.ok(verifyGateReceipt(receipt, { expectedPublicKey: env.config.gate.expectPublicKey }));
  assert.equal(st.gate.verified, true);
  assert.equal(st.gate.publicKeyPinned, true);
  assert.deepEqual([st.gate.atDecision.verified, st.gate.atDecision.publicKeyPinned], [true, true], 're-verified at decision time');
  assert.equal(st.flags.pairedEvidenceUsed, true);
  assert.equal(st.flags.gateCandidateDigestMatches, true);
  // the real gate tested at the PREREGISTERED alpha/lambda/split (adv 2), and plan, candidate and request agree (adv 1)
  const plan = JSON.parse(readFileSync(join(runDir, 'confirm', 'plan.json'), 'utf8'));
  assert.deepEqual([receipt.payload.config.alpha, receipt.payload.config.lambda, receipt.payload.config.candidateBudget],
    [Number(plan.gate.alpha), Number(plan.gate.lambda), plan.gate.candidateBudget]);
  assert.equal(st.flags.gateConfigMatchesPlan, true);
  assert.equal(st.flags.candidateMatchesPlan, true);

  // Blocked, for the right reasons, in auto mode.
  assert.equal(fakes.calls.submit.length, 0);
  for (const r of ['darwinEvidenceIsScorecards', 'confirmationNotDryRun']) assert.ok(st.decision.reasons.includes(r), String(st.decision.reasons));
  if (!st.gate.bindingSupported) assert.ok(st.decision.reasons.includes('requestDigestBoundInGateReceipt'));
  // Only evidence/gate reasons remain: preregistration, provenance, cells, paired use, key pin, digests and checks all hold.
  // (imageEnvSourceMatchesPlan: a dry-run plan's envSourceSha is DRY_SHA, never a real image's env source.)
  const allowed = ['darwinEvidenceIsScorecards', 'confirmationNotDryRun', 'gatePromote', 'requestDigestBoundInGateReceipt', 'imageEnvSourceMatchesPlan'];
  assert.deepEqual(st.decision.reasons.filter(r => !allowed.includes(r)), [], String(st.decision.reasons));
  if (!st.gate.promote) assert.ok(st.needsHuman, 'day 1 and the gate refused: needs-human request for the v2 defaults');
  assert.deepEqual(fakes.calls.down.length, 0);
});
