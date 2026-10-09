import { hash } from './curriculum.mjs';

const ok = (condition, reason) => { if (!condition) throw new Error(reason); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value);
const unique = values => new Set(values).size === values.length;

/** Posthoc descriptive evidence only. No candidate, holdout, training or authority claims. */
export function diagnoseCalibration({ manifest, calibration }) {
  ok(exact(manifest, ['tasks', 'environmentSource']), 'invalid_native_manifest');
  ok(Array.isArray(manifest.tasks) && manifest.tasks.length >= 1 && manifest.tasks.length <= 50, 'invalid_native_tasks');
  const taskIds = manifest.tasks.map(task => {
    ok(exact(task, ['task_id', 'split']) && id(task.task_id) && task.split === 'train', 'invalid_native_training_task');
    return task.task_id;
  });
  ok(unique(taskIds), 'duplicate_native_task');
  let sourceBinding = 'legacy_task_ids_only_environment_unbound';
  if (manifest.environmentSource !== undefined) {
    const source = manifest.environmentSource;
    ok(exact(source, ['components', 'sha256']) && exact(source.components, ['arena_env/tasks.py', 'arena_env/environment.py']), 'invalid_environment_source');
    ok(Object.keys(source.components).length === 2 && Object.values(source.components).every(digest), 'invalid_environment_components');
    ok(digest(source.sha256) && hash(source.components) === source.sha256, 'environment_source_digest_mismatch');
    sourceBinding = 'named_environment_source_digests_no_execution_attestation';
  }
  ok(exact(calibration, ['kind', 'source', 'modelId', 'runnerRevision', 'manifestDigest', 'groups']), 'invalid_calibration_fields');
  ok(calibration.kind === 'proxy_calibration' && calibration.source === 'model_rollouts', 'proxy_model_receipt_required');
  ok(id(calibration.modelId) && digest(calibration.runnerRevision), 'invalid_calibration_provenance');
  ok(digest(calibration.manifestDigest) && hash(manifest) === calibration.manifestDigest, 'native_manifest_digest_mismatch');
  ok(Array.isArray(calibration.groups) && calibration.groups.length === taskIds.length, 'incomplete_calibration_groups');
  const groups = calibration.groups.map(group => {
    ok(exact(group, ['taskId', 'family', 'attempts']) && taskIds.includes(group.taskId) && id(group.family), 'invalid_calibration_group');
    ok(group.taskId === group.family || /^[123]$/.test(group.taskId.slice(group.family.length + 2)) && group.taskId.startsWith(group.family + '-d'), 'task_family_mismatch');
    ok(Array.isArray(group.attempts) && group.attempts.length === 4, 'four_actual_attempts_required');
    group.attempts.forEach(attempt => {
      ok(exact(attempt, ['seed', 'reward', 'success', 'trajectoryDigest']), 'invalid_attempt_fields');
      ok(Number.isSafeInteger(attempt.seed) && attempt.seed >= 0 && typeof attempt.reward === 'number'
        && Number.isFinite(attempt.reward) && attempt.reward >= 0 && attempt.reward <= 1
        && typeof attempt.success === 'boolean' && attempt.success === (attempt.reward === 1)
        && digest(attempt.trajectoryDigest), 'invalid_attempt');
    });
    ok(unique(group.attempts.map(attempt => attempt.seed)), 'duplicate_attempt_seed');
    ok(unique(group.attempts.map(attempt => attempt.trajectoryDigest)), 'duplicate_attempt_trajectory');
    const successes = group.attempts.filter(attempt => attempt.success).length;
    const rewards = group.attempts.map(attempt => attempt.reward);
    const meanReward = rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length;
    return { taskId: group.taskId, family: group.family, attempts: 4, successes, rewards,
      meanReward, rewardStd: Math.sqrt(rewards.reduce((sum, reward) => sum + (reward - meanReward) ** 2, 0) / rewards.length),
      zeroVariance: new Set(rewards).size === 1, mixedSuccess: successes >= 1 && successes <= 3,
      saturatedObserved: successes === 4 };
  });
  ok(unique(groups.map(group => group.taskId)), 'duplicate_calibration_task');
  ok(unique(calibration.groups.flatMap(group => group.attempts.map(attempt => attempt.trajectoryDigest))), 'reused_calibration_trajectory');
  return { kind: 'posthoc_calibration_diagnostic', scope: 'descriptive_proxy_calibration_only',
    manifestDigest: hash(manifest), evidenceDigest: hash(calibration), modelId: calibration.modelId,
    sourceBinding, groups, posthoc: true, preregistered: false, promote: false,
    selectionAuthorized: false, officialScore: null, trainingImprovement: null,
    claim: 'Descriptive retained-rollout diagnostics, not a preregistered transfer study, policy promotion or Arena score. Receipt hashes do not attest model execution.' };
}
