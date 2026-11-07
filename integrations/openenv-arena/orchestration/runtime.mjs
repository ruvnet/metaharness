import { execFileSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { calibrate, hash, PROVENANCE, reviewCandidate, signLocalDecision, validatePlan } from './curriculum.mjs';
import { diagnoseCalibration } from './diagnostics.mjs';

export const CAPABILITIES = Object.freeze(['arena.validate_plan', 'arena.calibrate', 'arena.review', 'arena.diagnose_calibration']);

/** RGI_ROOT is a reviewed local code checkout, never a path supplied by model output. */
export async function loadRgi(root = process.env.RGI_ROOT) {
  if (!root || !isAbsolute(root)) throw new Error('RGI_ROOT_must_be_absolute_trusted_checkout');
  const pin = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (pin !== PROVENANCE.rgi) throw new Error('rgi_revision_mismatch');
  const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all', '--ignored', '--', 'src', 'package.json'], { encoding: 'utf8' }).trim();
  if (dirty) throw new Error('rgi_source_dirty');
  const [{ Runtime }, { MetaHarnessExecutor }] = await Promise.all([
    import(pathToFileURL(resolve(root, 'src/runtime.ts')).href),
    import(pathToFileURL(resolve(root, 'src/adapters/metaharness.ts')).href),
  ]);
  return { Runtime, MetaHarnessExecutor };
}

/** Local-only, fixed handlers. No shell, arbitrary URLs, publishing or submission capability. */
export async function openWorkflow({ dbPath, rgiRoot, allowedCapabilities = [], allowLocalSelection = false, rollbackManifest }) {
  if (!allowedCapabilities.every(c => CAPABILITIES.includes(c))) throw new Error('unknown_capability');
  const { Runtime, MetaHarnessExecutor } = await loadRgi(rgiRoot);
  let runtime;
  const requireFrozenPlan = plan => {
    const frozen = runtime.restore('arena-plan-digest');
    if (!frozen) throw new Error('preregister_plan_first');
    if (frozen !== hash(plan)) throw new Error('journal_plan_changed');
  };
  const handlers = {
    'arena.diagnose_calibration': async payload => {
      const diagnostic = diagnoseCalibration(payload);
      return { ...diagnostic, receipt: signLocalDecision(diagnostic) };
    },
    'arena.validate_plan': async ({ plan }) => {
      validatePlan(plan);
      const frozen = runtime.restore('arena-plan-digest');
      if (frozen && frozen !== hash(plan)) throw new Error('journal_plan_changed');
      runtime.checkpoint('arena-plan-digest', hash(plan));
      return { kind: 'local_plan_validation', valid: true, planDigest: hash(plan), officialScore: null };
    },
    'arena.calibrate': async ({ plan, calibration }) => { requireFrozenPlan(plan); return calibrate(calibration, plan); },
    'arena.review': async ({ plan, candidateId, calibration, controls, transfer }) => {
      const key = `arena-review-${hash(plan).slice(0, 32)}`;
      // A second plan in the same journal cannot reset the preregistered candidate budget.
      requireFrozenPlan(plan);
      const result = reviewCandidate({ plan, candidateId, calibration, controls, transfer,
        ledger: runtime.restore(key) ?? { reviews: [] },
        authority: { allowLocalSelection, rollbackManifestDigest: rollbackManifest ? hash(rollbackManifest) : null } });
      runtime.checkpoint('arena-plan-digest', hash(plan));
      // Consume the audit before returning. An interruption cannot re-use it silently.
      runtime.checkpoint(key, result.ledger);
      if (result.decision.promote) runtime.checkpoint('arena-selected-manifest', {
        candidateId, manifestDigest: plan.candidates.find(c => c.id === candidateId).manifestDigest,
        rollbackManifestDigest: plan.baseline.manifestDigest, scope: 'local_artifact_selection_only',
      });
      return { ...result.decision, receipt: signLocalDecision(result.decision) };
    },
  };
  const fields = {
    'arena.diagnose_calibration': ['manifest', 'calibration'],
    'arena.validate_plan': ['plan'], 'arena.calibrate': ['plan', 'calibration'],
    'arena.review': ['plan', 'candidateId', 'calibration', 'controls', 'transfer'],
  };
  const executor = new MetaHarnessExecutor(CAPABILITIES.map(capability => ({
    capability, costMicros: 0,
    tool: { name: capability, server: 'openenv-arena-local', description: 'Bounded local evidence review', inputSchema: { type: 'object' },
      handler: async payload => {
        try { return await handlers[capability](payload); }
        catch (error) { return { kind: 'rejected_local_input', accepted: false, reason: error.message, officialScore: null }; }
      } },
    validate: payload => Object.keys(payload).length === fields[capability].length && fields[capability].every(k => Object.hasOwn(payload, k)),
  })));
  runtime = new Runtime({ dbPath, executor, config: { allowedCapabilities: [...allowedCapabilities],
    budgetMicros: 0, maxRecordBytes: 1_048_576, maxQueue: 16, maxDatabaseBytes: 16_777_216,
    actionTimeoutMs: 10000, leaseMs: 30000 } });
  return runtime;
}

export function actionFor(capability, payload) {
  return { id: `arena:${hash({ capability, payload })}`, capability, payload, confidence: 1, estimatedCostMicros: 0 };
}
