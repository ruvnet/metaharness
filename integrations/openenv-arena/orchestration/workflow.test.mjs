import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyReceipt } from '../../../packages/flywheel/src/receipts.ts';
import { calibrate, hash, reviewCandidate, signLocalDecision, validatePlan } from './curriculum.mjs';
import { actionFor, loadRgi, openWorkflow } from './runtime.mjs';

// Synthetic evidence exists only inside tests. It cannot establish Arena/model performance.
function fixture() {
  const rollbackManifest = { tasks: ['software_change', 'science_calibration'], difficulty: 1 };
  const proposedManifest = { tasks: ['software_change', 'science_calibration'], difficulty: 2 };
  const plan = { version: 1, id: 'test-only', maxCandidates: 2, alpha: 0.05, minLift: 0.02,
    baseline: { id: 'baseline', manifestDigest: hash(rollbackManifest), taskIds: rollbackManifest.tasks },
    candidates: [{ id: 'candidate', manifestDigest: hash(proposedManifest), taskIds: proposedManifest.tasks }],
    splits: { train: ['train_a', 'train_b'], selection: ['selection_a', 'selection_b'], anchor: ['anchor_a', 'anchor_b'] } };
  const calibration = { kind: 'proxy_calibration', source: 'model_rollouts', modelId: 'test/model', runnerRevision: hash('runner'),
    manifestDigest: plan.candidates[0].manifestDigest, groups: proposedManifest.tasks.map((taskId, index) => ({ taskId, family: plan.splits.train[index],
      attempts: [0, 1, 2, 3].map(seed => ({ seed, reward: seed < 2 ? 1 : 0, success: seed < 2, trajectoryDigest: hash(`${taskId}/${seed}`) })) })) };
  const controls = { kind: 'local_controls', manifestDigest: plan.candidates[0].manifestDigest,
    testsPassed: 12, testsTotal: 12, reportDigest: hash('controls') };
  const transfer = { kind: 'proxy_transfer', source: 'trained_proxy_model_rollouts', auditId: 'audit-1', baseModelId: 'test/model',
    trainingRecipeDigest: hash('recipe'), baselineCheckpointDigest: hash('baseline-checkpoint'), candidateCheckpointDigest: hash('candidate-checkpoint'),
    baselineManifestDigest: plan.baseline.manifestDigest, candidateManifestDigest: plan.candidates[0].manifestDigest,
    rows: ['selection', 'anchor'].flatMap(split => Array.from({ length: 20 }, (_, seed) => ({ split,
      family: plan.splits[split][seed % 2], taskId: `${split}-task-${seed}`, seed,
      baseline: { success: split === 'anchor', noop: split === 'selection', costMicros: 1, trajectoryDigest: hash(`base/${split}/${seed}`) },
      candidate: { success: true, noop: false, costMicros: 1, trajectoryDigest: hash(`cand/${split}/${seed}`) },
    }))) };
  return { plan, candidateId: 'candidate', calibration, controls, transfer, rollbackManifest,
    authority: { allowLocalSelection: true, rollbackManifestDigest: hash(rollbackManifest) } };
}
test('calibration requires 1 to 3 successful proxy attempts and varying rewards', () => {
  const f = fixture();
  assert.equal(calibrate(f.calibration, f.plan).ready, true);
  f.calibration.groups[0].attempts.forEach(a => { a.reward = 1; a.success = true; });
  const report = calibrate(f.calibration, f.plan);
  assert.equal(report.ready, false);
  assert.equal(report.groups[0].zeroVariance, true);
});
test('oracle controls and official results cannot masquerade as proxy calibration', () => {
  for (const kind of ['local_controls', 'official_private_eval']) {
    const f = fixture(); f.calibration.kind = kind;
    assert.throws(() => calibrate(f.calibration, f.plan), /model_rollouts_required/);
  }
});
test('calibration success must mean exact terminal reward one', () => {
  const f = fixture(); f.calibration.groups[0].attempts[0].reward = 0;
  assert.throws(() => calibrate(f.calibration, f.plan), /success_reward_mismatch/);
  const g = fixture(); g.calibration.groups[0].attempts[0].success = false;
  assert.throws(() => calibrate(g.calibration, g.plan), /success_reward_mismatch/);
  const h = fixture(); h.calibration.groups[0].attempts[0].reward = 0.5;
  assert.throws(() => calibrate(h.calibration, h.plan), /success_reward_mismatch/);
});
test('rejects train/holdout family leakage and unofficial mutable fields', () => {
  const f = fixture(); f.plan.splits.anchor[0] = 'train_a';
  assert.throws(() => validatePlan(f.plan), /family_leakage/);
  const other = fixture(); other.plan.model = 'changed';
  assert.throws(() => validatePlan(other.plan), /invalid_plan_fields/);
});
test('bounded paired gate selects only local artifact and signs replayable evidence', () => {
  const result = reviewCandidate(fixture());
  assert.equal(result.decision.promote, true);
  assert.equal(result.decision.officialScore, null);
  assert.equal(result.decision.scope, 'local_artifact_selection_only');
  const receipt = signLocalDecision(result.decision);
  assert.equal(verifyReceipt(receipt), true);
  receipt.payload.promote = false;
  assert.equal(verifyReceipt(receipt), false);
});
test('missing trained proxy data cannot promote despite perfect control tests', () => {
  const f = fixture(); f.transfer.kind = 'local_controls';
  assert.throws(() => reviewCandidate(f), /trained_proxy_transfer_required/);
});
test('gate requires authority, exact rollback and calibrated difficulty', () => {
  const f = fixture(); f.authority = {};
  f.calibration.groups[0].attempts.forEach(a => { a.reward = 1; a.success = true; });
  const { decision } = reviewCandidate(f);
  assert.equal(decision.promote, false);
  for (const reason of ['not_authorized', 'rollback_not_verified', 'uncalibrated_difficulty']) assert.ok(decision.reasons.includes(reason));
});
test('anchor/family regressions block a strong aggregate selection win', () => {
  const f = fixture(); f.transfer.rows[20].candidate.success = false;
  const { decision } = reviewCandidate(f);
  assert.equal(decision.promote, false);
  assert.ok(decision.reasons.includes('anchor_regressed'));
  assert.ok(decision.reasons.includes('family_regression:anchor_a'));
});
test('duplicate pair, duplicate trajectory, and unchanged checkpoint are refused', () => {
  const f = fixture(); f.transfer.rows[1] = structuredClone(f.transfer.rows[0]);
  assert.throws(() => reviewCandidate(f), /duplicate_audit_case/);
  const g = fixture(); g.transfer.candidateCheckpointDigest = g.transfer.baselineCheckpointDigest;
  assert.throws(() => reviewCandidate(g), /distinct_trained_checkpoints_required/);
  const h = fixture(); h.transfer.rows[1].candidate.trajectoryDigest = h.transfer.rows[0].candidate.trajectoryDigest;
  assert.throws(() => reviewCandidate(h), /reused_trajectory/);
});
test('audit reuse and plan edits cannot reset the candidate budget', () => {
  const f = fixture(); const first = reviewCandidate(f);
  assert.throws(() => reviewCandidate({ ...f, ledger: first.ledger }), /candidate_already_reviewed/);
  f.plan.alpha = 0.01;
  assert.throws(() => reviewCandidate({ ...f, ledger: first.ledger }), /plan_changed_after_freeze/);
});
test('cost regression and non-finite score inputs cannot produce a promotion', () => {
  const f = fixture(); f.transfer.rows.forEach(row => { row.candidate.costMicros = 1000; });
  const { decision } = reviewCandidate(f);
  assert.equal(decision.promote, false);
  assert.ok(decision.reasons.includes('cost_per_win_worsened'));
  const g = fixture(); g.calibration.groups[0].attempts[0].reward = NaN;
  assert.throws(() => reviewCandidate(g), /invalid_attempt/);
});

const needsRgi = { skip: !process.env.RGI_ROOT && 'Set RGI_ROOT to run integration against pinned actual rGi' };
test('actual rGi imports reject untracked, ignored source and changed package metadata', needsRgi, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-rgi-source-'));
  const checkout = join(dir, 'rgi');
  try {
    execFileSync('git', ['clone', '--quiet', '--shared', process.env.RGI_ROOT, checkout]);
    writeFileSync(join(checkout, 'src', 'extra.ts'), 'export const unexpected = true;\n');
    await assert.rejects(loadRgi(checkout), /rgi_source_dirty/);
    appendFileSync(join(checkout, '.git', 'info', 'exclude'), '\nsrc/extra.ts\n');
    await assert.rejects(loadRgi(checkout), /rgi_source_dirty/);
    rmSync(join(checkout, 'src', 'extra.ts'));
    const packagePath = join(checkout, 'package.json');
    writeFileSync(packagePath, readFileSync(packagePath, 'utf8') + '\n');
    await assert.rejects(loadRgi(checkout), /rgi_source_dirty/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('actual rGi requires preregistration and refuses a changed frozen plan', needsRgi, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-rgi-'));
  let runtime;
  try {
    const f = fixture();
    runtime = await openWorkflow({ dbPath: join(dir, 'test.db'), allowedCapabilities: ['arena.validate_plan', 'arena.calibrate'] });
    const a = actionFor('arena.calibrate', { plan: f.plan, calibration: f.calibration });
    runtime.enqueue(a); await runtime.step();
    const read = id => JSON.parse(runtime.store.db.prepare('SELECT result FROM jobs WHERE id=?').get(id).result);
    assert.equal(read(a.id).reason, 'preregister_plan_first');
    runtime.enqueue(actionFor('arena.validate_plan', { plan: f.plan })); await runtime.step();
    f.plan.alpha = 0.01;
    const changed = actionFor('arena.validate_plan', { plan: f.plan });
    runtime.enqueue(changed); await runtime.step();
    assert.equal(read(changed.id).reason, 'journal_plan_changed');
  } finally { runtime?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('actual rGi denies capabilities by default and denies nonexistent submission', needsRgi, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-rgi-'));
  let runtime;
  try {
    runtime = await openWorkflow({ dbPath: join(dir, 'test.db') });
    const a = actionFor('arena.validate_plan', { plan: fixture().plan });
    runtime.enqueue(a); await runtime.step();
    assert.equal(runtime.store.job(a.id).status, 'denied');
    const submit = actionFor('arena.submit', {}); runtime.enqueue(submit); await runtime.step();
    assert.equal(runtime.store.job(submit.id).status, 'denied');
  } finally { runtime?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('actual rGi durable receipt and completed IDs survive restart without replay', needsRgi, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-rgi-'));
  const config = { dbPath: join(dir, 'test.db'), allowedCapabilities: ['arena.validate_plan', 'arena.calibrate'] };
  let runtime;
  try {
    const f = fixture(); const action = actionFor('arena.calibrate', { plan: f.plan, calibration: f.calibration });
    runtime = await openWorkflow(config);
    runtime.enqueue(actionFor('arena.validate_plan', { plan: f.plan })); await runtime.step();
    assert.equal(runtime.enqueue(action), true); await runtime.step();
    assert.equal(runtime.status().jobs.succeeded, 2); runtime.close();
    runtime = await openWorkflow(config); assert.equal(runtime.enqueue(action), false);
    assert.equal(runtime.status().jobs.succeeded, 2);
  } finally { runtime?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('actual rGi journals gate decision, rollback and consumed audit across restart', needsRgi, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-rgi-'));
  const f = fixture();
  const config = { dbPath: join(dir, 'test.db'), allowedCapabilities: ['arena.validate_plan', 'arena.review'], allowLocalSelection: true, rollbackManifest: f.rollbackManifest };
  const payload = { plan: f.plan, candidateId: f.candidateId, calibration: f.calibration, controls: f.controls, transfer: f.transfer };
  let runtime;
  try {
    runtime = await openWorkflow(config); const action = actionFor('arena.review', payload);
    runtime.enqueue(actionFor('arena.validate_plan', { plan: f.plan })); await runtime.step();
    runtime.enqueue(action); await runtime.step();
    assert.equal(runtime.restore('arena-selected-manifest').manifestDigest, f.plan.candidates[0].manifestDigest);
    runtime.close(); runtime = await openWorkflow(config);
    const repeat = { ...action, id: `${action.id}-retry` }; runtime.enqueue(repeat); await runtime.step();
    const body = runtime.store.db.prepare('SELECT result FROM jobs WHERE id=?').get(repeat.id).result;
    assert.equal(JSON.parse(body).reason, 'candidate_already_reviewed');
  } finally { runtime?.close(); rmSync(dir, { recursive: true, force: true }); }
});
