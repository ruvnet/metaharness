import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from './curriculum.mjs';
import { diagnoseCalibration } from './diagnostics.mjs';
import { openWorkflow, actionFor } from './runtime.mjs';

// Synthetic unit fixtures only. Retained real rollouts are executed separately.
function fixture(taskId = 'office_reconciliation-d1', family = 'office_reconciliation') {
  const manifest = { tasks: [{ task_id: taskId, split: 'train' }] };
  const calibration = { kind: 'proxy_calibration', source: 'model_rollouts', modelId: 'fixture:model',
    runnerRevision: 'a'.repeat(64), manifestDigest: hash(manifest),
    groups: [{ taskId, family,
      attempts: [1, 0.5, 1, 1].map((reward, seed) => ({ seed, reward, success: reward === 1, trajectoryDigest: hash({ seed, reward }) })) }] };
  return { manifest, calibration };
}

test('legacy diagnostics report weak binding without a fabricated selection plan', () => {
  const result = diagnoseCalibration(fixture());
  assert.equal(result.sourceBinding, 'legacy_task_ids_only_environment_unbound');
  assert.equal(result.posthoc, true);
  assert.equal(result.preregistered, false);
  assert.equal(result.promote, false);
  assert.equal(result.selectionAuthorized, false);
  assert.equal(result.groups[0].successes, 3);
  assert.equal(result.groups[0].mixedSuccess, true);
  assert.equal(result.groups[0].meanReward, 0.875);
});

test('native base IDs and all bounded nonzero knob values preserve descriptive scope', () => {
  const families = ['software_change', 'industrial_schedule', 'science_calibration', 'office_reconciliation',
    'finance_ledger', 'math_route', 'security_triage', 'media_timeline'];
  for (const family of families) {
    for (const taskId of [family, ...[1, 2, 3].map(level => `${family}-d${level}`)]) {
      assert.equal(diagnoseCalibration(fixture(taskId, family)).groups[0].family, family);
    }
  }
  for (const level of [1, 2, 3]) {
    for (const [family, knob, values] of [['software_change', 'suite_count_delta', [-1, 1, 2]],
      ['science_calibration', 'sample_count_delta', [-2, -1, 1, 2]]]) {
      for (const value of values) {
        const taskId = `${family}-d${level}--${knob}-${value > 0 ? 'p' : 'm'}${Math.abs(value)}`;
        const result = diagnoseCalibration(fixture(taskId, family));
        assert.equal(result.groups[0].taskId, taskId);
        assert.equal(result.promote, false);
        assert.equal(result.posthoc, true);
      }
    }
  }
});

test('unknown families, noncanonical knobs, invalid bounds and wrong receipt families are rejected', () => {
  const invalid = ['bogus', 'bogus-d2', 'software_change-d0', 'software_change-d4', 'software_change-d02',
    'software_change--suite_count_delta-p1', 'software_change-d2--suite_count_delta-p0',
    'software_change-d2--suite_count_delta-m0', 'software_change-d2--suite_count_delta-p01',
    'software_change-d2--suite_count_delta-m2', 'software_change-d2--suite_count_delta-p3',
    'science_calibration-d2--sample_count_delta-m3', 'science_calibration-d2--sample_count_delta-+1',
    'software_change-d2--sample_count_delta-p1', 'science_calibration-d2--suite_count_delta-p1',
    'math_route-d2--suite_count_delta-p1', 'software_change-d2--unknown-p1',
    'software_change-d2--suite_count_delta-p1--suite_count_delta-p1'];
  for (const taskId of invalid) {
    assert.throws(() => diagnoseCalibration(fixture(taskId, 'software_change')), /invalid_native_training_task/, taskId);
  }
  assert.throws(() => diagnoseCalibration(fixture('software_change-d3--suite_count_delta-p1', 'science_calibration')), /task_family_mismatch/);
});

test('manifest, source components and receipt outcomes must match', () => {
  const input = fixture();
  input.manifest.environmentSource = { components: { 'arena_env/tasks.py': 'b'.repeat(64), 'arena_env/environment.py': 'c'.repeat(64) } };
  input.manifest.environmentSource.sha256 = hash(input.manifest.environmentSource.components);
  input.calibration.manifestDigest = hash(input.manifest);
  assert.equal(diagnoseCalibration(input).sourceBinding, 'named_environment_source_digests_no_execution_attestation');
  input.manifest.environmentSource.components['arena_env/tasks.py'] = 'd'.repeat(64);
  assert.throws(() => diagnoseCalibration(input), /environment_source_digest_mismatch/);
  const other = fixture(); other.manifest.tasks[0].task_id = 'math_route-d1';
  assert.throws(() => diagnoseCalibration(other), /native_manifest_digest_mismatch/);
  const outcome = fixture(); outcome.calibration.groups[0].attempts[0].success = false;
  assert.throws(() => diagnoseCalibration(outcome), /invalid_attempt/);
});

test('incomplete groups and duplicate trajectories remain rejected', () => {
  const input = fixture(); input.calibration.groups[0].attempts.pop();
  assert.throws(() => diagnoseCalibration(input), /four_actual_attempts_required/);
  const duplicate = fixture(); duplicate.calibration.groups[0].attempts[1].trajectoryDigest = duplicate.calibration.groups[0].attempts[0].trajectoryDigest;
  assert.throws(() => diagnoseCalibration(duplicate), /duplicate_attempt_trajectory/);
});

test('actual pinned rGi stores diagnostic only and defaults to denying its capability', async () => {
  assert.ok(process.env.RGI_ROOT, 'Set RGI_ROOT to the trusted pinned checkout for this integration test');
  const directory = mkdtempSync(join(tmpdir(), 'arena-diagnostic-'));
  try {
    const denied = await openWorkflow({ dbPath: join(directory, 'denied.db'), allowedCapabilities: [] });
    const action = actionFor('arena.diagnose_calibration', fixture());
    denied.enqueue(action); await denied.step();
    assert.equal(denied.store.job(action.id).status, 'denied'); denied.close();
    const dbPath = join(directory, 'diagnostic.db');
    const runtime = await openWorkflow({ dbPath, allowedCapabilities: ['arena.diagnose_calibration'] });
    runtime.enqueue(action); await runtime.step();
    assert.equal(runtime.store.job(action.id).status, 'succeeded');
    const result = JSON.parse(runtime.store.db.prepare('SELECT result FROM jobs WHERE id=?').get(action.id).result);
    assert.equal(result.promote, false); assert.equal(result.preregistered, false);
    assert.ok(result.receipt);
    assert.equal(runtime.restore('arena-selected-manifest'), undefined);
    const review = actionFor('arena.review', {});
    runtime.enqueue(review); await runtime.step();
    assert.equal(runtime.store.job(review.id).status, 'denied'); runtime.close();
    const restarted = await openWorkflow({ dbPath, allowedCapabilities: ['arena.diagnose_calibration'] });
    assert.equal(restarted.enqueue(action), false); restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
