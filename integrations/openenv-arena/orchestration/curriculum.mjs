import { createHash } from 'node:crypto';
import { canon, makeSigner } from '../../../packages/flywheel/src/receipts.ts';
import { meetsPromotionRule, gateFingerprint } from '../../../packages/flywheel/src/gate.ts';
import { sequentialEvidence } from '../../../packages/flywheel/src/sequential.ts';

export const PROVENANCE = Object.freeze({
  metaharness: 'ea287d6ef7548b0b32fa3e20956fa548cfe51edb',
  rgi: '2dd6adb526a7ca1d27b1c4d6cf98c828b390c421',
  openenv: '86a180ede21e044f7929b9a7783ad83aa67d83a3',
  autogenousContractSource: 'packages/autogenous/src/gate.ts',
  scope: 'local_curriculum_selection_only',
});
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(v);
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const array = (v, min = 1, max = 10000) => Array.isArray(v) && v.length >= min && v.length <= max;
const finite = (v, min = 0, max = Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const check = (ok, reason) => { if (!ok) throw new Error(reason); };
const exact = (v, keys, name) => check(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k)), `invalid_${name}_fields`);
const unique = v => new Set(v).size === v.length;
export const hash = value => createHash('sha256').update(canon(value)).digest('hex');

/** Frozen candidate manifests, not arbitrary model/trainer mutations. */
export function validatePlan(plan) {
  exact(plan, ['version', 'id', 'maxCandidates', 'alpha', 'minLift', 'baseline', 'candidates', 'splits'], 'plan');
  check(plan.version === 1 && identifier(plan.id), 'invalid_plan_identity');
  check(Number.isInteger(plan.maxCandidates) && plan.maxCandidates >= 1 && plan.maxCandidates <= 8, 'invalid_candidate_budget');
  check(finite(plan.alpha, 0.001, 0.05) && finite(plan.minLift, 0.01, 0.5), 'invalid_gate_thresholds');
  exact(plan.splits, ['train', 'selection', 'anchor'], 'splits');
  for (const split of ['train', 'selection', 'anchor']) {
    check(array(plan.splits[split], 2, 100) && plan.splits[split].every(identifier) && unique(plan.splits[split]), `invalid_${split}_families`);
  }
  const families = Object.values(plan.splits).flat();
  check(unique(families), 'family_leakage');
  check(array(plan.candidates, 1, plan.maxCandidates), 'invalid_candidates');
  for (const candidate of [plan.baseline, ...plan.candidates]) {
    exact(candidate, ['id', 'manifestDigest', 'taskIds'], 'candidate');
    check(identifier(candidate.id) && digest(candidate.manifestDigest), 'invalid_candidate_identity');
    check(array(candidate.taskIds, 1, 50) && candidate.taskIds.every(identifier) && unique(candidate.taskIds), 'invalid_task_ids');
  }
  check(unique([plan.baseline, ...plan.candidates].map(c => c.id)), 'duplicate_candidate');
  check(unique([plan.baseline, ...plan.candidates].map(c => c.manifestDigest)), 'duplicate_manifest');
  return plan;
}

/** A calibration group is four actual model rollouts on one training task. */
export function calibrate(receipt, plan) {
  validatePlan(plan);
  exact(receipt, ['kind', 'modelId', 'runnerRevision', 'manifestDigest', 'groups', 'source'], 'calibration');
  check(receipt.kind === 'proxy_calibration' && receipt.source === 'model_rollouts', 'model_rollouts_required');
  check(identifier(receipt.modelId) && digest(receipt.runnerRevision) && digest(receipt.manifestDigest), 'invalid_calibration_provenance');
  const candidate = [plan.baseline, ...plan.candidates].find(c => c.manifestDigest === receipt.manifestDigest);
  check(candidate, 'unregistered_manifest');
  check(array(receipt.groups, 1, 500), 'invalid_calibration_groups');
  const groups = receipt.groups.map(group => {
    exact(group, ['taskId', 'family', 'attempts'], 'calibration_group');
    check(candidate.taskIds.includes(group.taskId) && plan.splits.train.includes(group.family), 'calibration_outside_training_split');
    check(array(group.attempts, 4, 4), 'four_proxy_attempts_required');
    group.attempts.forEach(a => {
      exact(a, ['seed', 'reward', 'success', 'trajectoryDigest'], 'attempt');
      check(Number.isSafeInteger(a.seed) && a.seed >= 0 && finite(a.reward, 0, 1) && typeof a.success === 'boolean' && digest(a.trajectoryDigest), 'invalid_attempt');
      check(a.success === (a.reward === 1), 'success_reward_mismatch');
    });
    check(unique(group.attempts.map(a => a.seed)), 'duplicate_calibration_seed');
    check(unique(group.attempts.map(a => a.trajectoryDigest)), 'duplicate_calibration_trajectory');
    const successes = group.attempts.filter(a => a.success).length;
    const zeroVariance = new Set(group.attempts.map(a => a.reward)).size === 1;
    return { taskId: group.taskId, family: group.family, successes, attempts: 4, zeroVariance,
      usableGradient: successes >= 1 && successes <= 3 && !zeroVariance,
      action: zeroVariance ? 'repair_reward_or_adjust_difficulty' : successes === 0 ? 'reduce_difficulty' : successes === 4 ? 'increase_difficulty' : 'retain' };
  });
  check(unique(groups.map(g => g.taskId)), 'duplicate_calibration_task');
  check(candidate.taskIds.every(id => groups.some(g => g.taskId === id)), 'incomplete_task_calibration');
  return { kind: 'proxy_calibration_summary', evidenceDigest: hash(receipt), manifestDigest: receipt.manifestDigest,
    modelId: receipt.modelId, groups, ready: groups.every(g => g.usableGradient),
    officialScore: null, claim: 'Difficulty diagnostic only; no measured training or transfer improvement.' };
}

function validateControls(controls) {
  exact(controls, ['kind', 'manifestDigest', 'testsPassed', 'testsTotal', 'reportDigest'], 'controls');
  check(controls.kind === 'local_controls' && digest(controls.manifestDigest) && digest(controls.reportDigest), 'invalid_control_provenance');
  check(Number.isSafeInteger(controls.testsTotal) && controls.testsTotal > 0 && controls.testsPassed === controls.testsTotal, 'controls_failed');
}
function validateTransfer(transfer, plan, candidate) {
  exact(transfer, ['kind', 'source', 'auditId', 'baseModelId', 'trainingRecipeDigest', 'baselineCheckpointDigest', 'candidateCheckpointDigest', 'baselineManifestDigest', 'candidateManifestDigest', 'rows'], 'transfer');
  check(transfer.kind === 'proxy_transfer' && transfer.source === 'trained_proxy_model_rollouts', 'trained_proxy_transfer_required');
  check(identifier(transfer.auditId) && identifier(transfer.baseModelId), 'invalid_proxy_identity');
  for (const name of ['trainingRecipeDigest', 'baselineCheckpointDigest', 'candidateCheckpointDigest', 'baselineManifestDigest', 'candidateManifestDigest']) check(digest(transfer[name]), `invalid_${name}`);
  check(transfer.baselineCheckpointDigest !== transfer.candidateCheckpointDigest, 'distinct_trained_checkpoints_required');
  check(transfer.baselineManifestDigest === plan.baseline.manifestDigest && transfer.candidateManifestDigest === candidate.manifestDigest, 'manifest_mismatch');
  check(array(transfer.rows, 40, 10000), 'insufficient_proxy_pairs');
  const keys = [];
  for (const row of transfer.rows) {
    exact(row, ['split', 'family', 'taskId', 'seed', 'baseline', 'candidate'], 'transfer_row');
    check(['selection', 'anchor'].includes(row.split) && plan.splits[row.split].includes(row.family) && identifier(row.taskId), 'transfer_split_leakage');
    check(!plan.baseline.taskIds.includes(row.taskId) && !candidate.taskIds.includes(row.taskId), 'training_task_leakage');
    check(Number.isSafeInteger(row.seed) && row.seed >= 0, 'invalid_paired_seed');
    for (const arm of [row.baseline, row.candidate]) {
      exact(arm, ['success', 'noop', 'costMicros', 'trajectoryDigest'], 'transfer_arm');
      check(typeof arm.success === 'boolean' && typeof arm.noop === 'boolean' && Number.isSafeInteger(arm.costMicros) && arm.costMicros >= 0 && digest(arm.trajectoryDigest), 'invalid_proxy_arm');
    }
    check(row.baseline.trajectoryDigest !== row.candidate.trajectoryDigest, 'same_trajectory_both_arms');
    keys.push(`${row.family}/${row.taskId}/${row.seed}`);
  }
  check(unique(keys), 'duplicate_audit_case');
  check(unique(transfer.rows.flatMap(row => [row.baseline.trajectoryDigest, row.candidate.trajectoryDigest])), 'reused_trajectory');
  for (const split of ['selection', 'anchor']) {
    const rows = transfer.rows.filter(r => r.split === split);
    check(rows.length >= 20 && new Set(rows.map(r => r.family)).size >= 2, `insufficient_${split}_coverage`);
    check(plan.splits[split].every(f => rows.some(r => r.family === f)), `missing_${split}_family`);
  }
}
function score(rows, arm) {
  const wins = rows.filter(r => r[arm].success).length;
  const total = rows.reduce((sum, r) => sum + r[arm].costMicros, 0);
  check(Number.isSafeInteger(total), 'invalid_total_cost');
  return { primary: wins / rows.length, noopRate: rows.filter(r => r[arm].noop).length / rows.length,
    costPerWin: total / Math.max(1, wins), regressed: false };
}

/** Dedicated curriculum bridge for Autogenous' conjunction. Never calls its radio-MoE gate. */
export function reviewCandidate({ plan, candidateId, calibration, controls, transfer, authority, ledger = { reviews: [] } }) {
  validatePlan(plan);
  const candidate = plan.candidates.find(c => c.id === candidateId);
  check(candidate, 'unknown_candidate');
  check(Array.isArray(ledger.reviews), 'invalid_ledger');
  const planDigest = hash(plan);
  check(ledger.planDigest === undefined || ledger.planDigest === planDigest, 'plan_changed_after_freeze');
  check(ledger.reviews.length < plan.maxCandidates, 'candidate_budget_exhausted');
  check(!ledger.reviews.some(r => r.candidateId === candidateId), 'candidate_already_reviewed');
  const diagnostic = calibrate(calibration, plan);
  check(calibration.manifestDigest === candidate.manifestDigest, 'calibration_manifest_mismatch');
  validateControls(controls);
  check(controls.manifestDigest === candidate.manifestDigest, 'controls_manifest_mismatch');
  validateTransfer(transfer, plan, candidate);
  const caseKeys = transfer.rows.map(r => `${r.family}/${r.taskId}/${r.seed}`);
  check(!ledger.reviews.some(r => r.auditId === transfer.auditId || r.caseKeys.some(k => caseKeys.includes(k))), 'audit_reuse_forbidden');
  const selection = transfer.rows.filter(r => r.split === 'selection');
  const anchor = transfer.rows.filter(r => r.split === 'anchor');
  const baseline = score(selection, 'baseline'), proposed = score(selection, 'candidate');
  const anchorScore = { baseline: score(anchor, 'baseline').primary, candidate: score(anchor, 'candidate').primary };
  const generic = meetsPromotionRule({ baseline, candidate: proposed, anchor: anchorScore });
  // A fixed preregistered candidate budget splits alpha across candidates. No audit-case reuse.
  const sequential = sequentialEvidence(selection.map(r => ({ itemId: `${r.family}/${r.taskId}/${r.seed}`,
    baselineWon: r.baseline.success, candidateWon: r.candidate.success })), { alpha: plan.alpha / plan.maxCandidates });
  const reasons = [...generic.reasons];
  if (!diagnostic.ready) reasons.push('uncalibrated_difficulty');
  if (proposed.primary - baseline.primary < plan.minLift) reasons.push('insufficient_proxy_lift');
  if (!sequential.significant) reasons.push('insufficient_paired_proxy_evidence');
  for (const family of [...plan.splits.selection, ...plan.splits.anchor]) {
    const rows = transfer.rows.filter(r => r.family === family);
    if (score(rows, 'candidate').primary < score(rows, 'baseline').primary) reasons.push(`family_regression:${family}`);
  }
  // Authority comes from the trusted host, never the model-produced evidence.
  if (!authority?.allowLocalSelection) reasons.push('not_authorized');
  if (authority?.rollbackManifestDigest !== plan.baseline.manifestDigest) reasons.push('rollback_not_verified');
  const decision = { kind: 'local_curriculum_review', candidateId, planDigest, promote: reasons.length === 0,
    scope: 'local_artifact_selection_only', predicate: 'Better AND Safe AND Authorized AND Reversible', reasons,
    baseline, candidate: proposed, anchor: anchorScore, sequential,
    evidence: { calibration: hash(calibration), controls: hash(controls), transfer: hash(transfer) },
    gateFingerprint: gateFingerprint(reviewCandidate), upstreamGateFingerprint: gateFingerprint(meetsPromotionRule),
    pairedEvidenceFingerprint: gateFingerprint(sequentialEvidence), provenance: PROVENANCE, officialScore: null,
    claim: 'Proxy evidence is conditional on declared rollout provenance and independence assumptions; not an Arena score.' };
  const nextLedger = { planDigest, reviews: [...ledger.reviews, { candidateId, auditId: transfer.auditId, caseKeys, decisionDigest: hash(decision) }] };
  return { decision, ledger: nextLedger };
}

export function signLocalDecision(decision) { return makeSigner().sign(decision); }
