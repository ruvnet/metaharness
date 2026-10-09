import { hash } from './curriculum.mjs';

const ok = (condition, reason) => { if (!condition) throw new Error(reason); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value);
const unique = values => new Set(values).size === values.length;
// Mirror the bounded native ID grammar in arena_env.tasks.parse_task_id. This
// descriptive adapter cannot load Python or introduce additional environment knobs.
const families = new Set(['software_change', 'industrial_schedule', 'science_calibration',
  'office_reconciliation', 'finance_ledger', 'math_route', 'security_triage', 'media_timeline']);
const knobs = { software_change: ['suite_count_delta', -1, 2], science_calibration: ['sample_count_delta', -2, 2] };
function nativeFamily(taskId) {
  if (families.has(taskId)) return taskId;
  if (typeof taskId !== 'string') return null;
  const match = /^([a-z_]+)-d([123])(?:--([a-z_]+)-([pm])([12]))?$/.exec(taskId);
  if (!match || !families.has(match[1])) return null;
  const [, family, , knob, sign, magnitude] = match;
  if (!knob) return family;
  const spec = knobs[family], value = Number(magnitude) * (sign === 'p' ? 1 : -1);
  return spec && knob === spec[0] && value >= spec[1] && value <= spec[2] ? family : null;
}

/** Posthoc descriptive evidence only. No candidate, holdout, training or authority claims. */
export function diagnoseCalibration({ manifest, calibration }) {
  ok(exact(manifest, ['tasks', 'environmentSource', 'chat_template_kwargs']), 'invalid_native_manifest');
  const chatTemplateRecorded = Object.hasOwn(manifest, 'chat_template_kwargs');
  const chatTemplateKwargs = manifest.chat_template_kwargs;
  if (chatTemplateRecorded) {
    ok(chatTemplateKwargs === null || (exact(chatTemplateKwargs, ['enable_thinking'])
      && Object.keys(chatTemplateKwargs).length === 1
      && typeof chatTemplateKwargs.enable_thinking === 'boolean'), 'invalid_chat_template_kwargs');
  }
  ok(Array.isArray(manifest.tasks) && manifest.tasks.length >= 1 && manifest.tasks.length <= 50, 'invalid_native_tasks');
  const taskIds = manifest.tasks.map(task => {
    ok(exact(task, ['task_id', 'split']) && nativeFamily(task.task_id) && task.split === 'train', 'invalid_native_training_task');
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
    ok(nativeFamily(group.taskId) === group.family, 'task_family_mismatch');
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
    sourceBinding, chatTemplate: { recorded: chatTemplateRecorded,
      requestedKwargs: chatTemplateKwargs == null ? null : { enable_thinking: chatTemplateKwargs.enable_thinking },
      effect: 'unverified' }, groups, posthoc: true, preregistered: false, promote: false,
    selectionAuthorized: false, officialScore: null, trainingImprovement: null,
    claim: 'Descriptive retained-rollout diagnostics, not a preregistered transfer study, policy promotion or Arena score. Receipt hashes do not attest model execution.' };
}
