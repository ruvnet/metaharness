import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runContrastive, digestDocument } from '../../dist/contrastive/index.js';
import { confirmContrastive } from '../../dist/contrastive/confirmation.js';
import { createContrastiveEditors } from '../../dist/contrastive/editors.js';
import { BASELINE, SOURCE, TAXONOMY, hash, loadFrozen } from './dataset.mjs';
import { MODEL, PROVIDER_TAG, LIMITS, createProvider } from './provider.mjs';
import { addCosts, createClassifier, createDevelopmentOptions, runSamplingControl, settleAll, executionEnvironment, EXECUTION_ENVELOPE } from './adapters.mjs';
import { sourceState } from './provenance.mjs';

export const POLICY = Object.freeze({ minCases: 40, minWins: 6, maxRegressions: 0, minGain: .05, alpha: .025 });
export function frozenPlan(frozen) {
  return { schemaVersion: 1, evidence: 'public-human-utterance-intent-confirmation',
    model: MODEL, providerEndpoint: PROVIDER_TAG, temperature: 0, taskOutputTokens: 96, editorOutputTokens: 1200,
    ratesUsdPerToken: { prompt: .0000001, completion: .0000004 }, limits: LIMITS,
    datasetSha256: frozen.frozenSha256, source: SOURCE, taxonomy: TAXONOMY,
    developmentTaskIds: frozen.development.map(x => x.id), confirmationTaskIds: frozen.confirmation.map(x => x.id),
    baseline: BASELINE, policy: POLICY, comparisons: ['contrastive-versus-baseline', 'contrastive-versus-control'], correction: 'Bonferroni: two prespecified comparisons, alpha .025 each',
    maximumProviderCalls: 318, maximumReservedUsdFromPlan: .744,
    control: 'Three independent complete-prompt proposals, selected by development accuracy. Equal development ceilings, not equal actual spend.',
    disclosure: 'Public CLINC150 may be in model training. Confirmation is unseen by this run, not proven model-unseen.' };
}
async function save(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
export async function runExperiment(provider, frozen, prefix, { mode = 'offline', source = null } = {}) {
  const cacheBinding = hash({ environment: executionEnvironment(frozen), envelope: EXECUTION_ENVELOPE });
  const classifier = createClassifier(provider, cacheBinding);
  const editors = createContrastiveEditors(request =>
    provider.complete({ ...request, stage: 'development:contrastive' }));
  const options = createDevelopmentOptions(frozen, classifier, editors);
  const contrastive = await runContrastive(options);
  const control = await runSamplingControl(frozen, classifier, provider, AbortSignal.timeout(1200000));
  const candidates = { baseline: structuredClone(BASELINE), contrastive: contrastive.candidate, control: control.candidate };
  const candidateFreeze = { datasetSha256: frozen.frozenSha256, source,
    candidates, digests: Object.fromEntries(Object.entries(candidates).map(([name, doc]) => [name, digestDocument(doc)])),
    developmentSelection: { contrastive: { outcome: contrastive.outcome, reason: contrastive.reason },
      control: { selectedIndex: control.selectedIndex, probes: control.probes } },
    frozenBeforeConfirmation: true };
  await save(prefix + '.candidates.json', { ...candidateFreeze, sha256: hash(candidateFreeze) });

  const byId = new Map(frozen.confirmation.map(row => [row.id, row]));
  async function confirm(baselineDocument, candidate, baselineName) {
    return confirmContrastive({
      tenantId: options.tenantId, projectId: options.projectId,
      environment: options.environment, envelope: options.envelope,
      baseline: baselineDocument, candidate,
      developmentTaskIds: frozen.development.map(x => x.id),
      confirmationTaskIds: frozen.confirmation.map(x => x.id),
      policy: POLICY,
      budget: { maxUsd: .16, maxCalls: 40, timeoutMs: 300000, pairUsd: 2 * LIMITS.taskUsd },
      evaluator: { surfaceAware: true, async evaluatePair(input) {
        assert.equal(input.tenantId, options.tenantId);
        assert.equal(input.projectId, options.projectId);
        assert.deepEqual(input.environment, options.environment);
        assert.deepEqual(input.envelope, options.envelope);
        const row = byId.get(input.taskId);
        assert.ok(row, 'undeclared confirmation row');
        assert.equal(digestDocument(input.baseline), input.baselineDigest);
        assert.equal(digestDocument(input.candidate), input.candidateDigest);
        const [baseline, candidate] = await settleAll([
          classifier.predict(input.baseline, row, 'confirmation:' + baselineName, input.signal),
          classifier.predict(input.candidate, row, 'confirmation:contrastive', input.signal),
        ]);
        return { tenantId: input.tenantId, projectId: input.projectId,
          environmentDigest: input.environmentDigest, envelopeDigest: input.envelopeDigest,
          taskId: row.id, appliedBaselineDigest: baseline.appliedDigest,
          appliedCandidateDigest: candidate.appliedDigest,
          baselinePassed: baseline.passed, candidatePassed: candidate.passed,
          costUsd: addCosts([baseline.costUsd, candidate.costUsd]) };
      } },
    });
  }
  const confirmations = {
    contrastiveVsBaseline: await confirm(candidates.baseline, candidates.contrastive, 'baseline'),
    contrastiveVsControl: await confirm(candidates.control, candidates.contrastive, 'control'),
  };
  // Unchanged candidates need no paired gate calls. Still measure their frozen
  // baseline accuracy once; identical candidate digests reuse exact predictions.
  const accuracy = {};
  for (const [name, candidate] of Object.entries(candidates)) {
    const rows = await settleAll(frozen.confirmation.map(row =>
      classifier.predict(candidate, row, 'confirmation:' + name, AbortSignal.timeout(180000))));
    const passed = rows.filter(x => x.passed).length;
    const predictionCost = addCosts(rows.map(x => x.originalCostUsd));
    const latency = rows.map(x => x.latencyMs).sort((a, b) => a - b);
    accuracy[name] = { passed, total: 40, costOfPredictionsUsedUsd: predictionCost,
      correctPerUsd: predictionCost ? passed / predictionCost : null,
      costPerCorrectUsd: passed ? predictionCost / passed : null,
      latencyMedianMs: latency[19], latencyP95Ms: latency[37],
      costNote: 'Measured cost of unique predictions used by this arm; shared cache is not billed twice. Actual incremental spend is in costByStage.',
      candidateDigest: digestDocument(candidate), rows };
  }
  if (source) assert.equal(sourceState().sourceAndBuildSha256, source.sourceAndBuildSha256, 'source changed during frozen run');
  const stages = [...new Set(provider.telemetry.map(x => x.stage))];
  return { schemaVersion: 1, mode, completed: true, source, cacheBindingSha256: cacheBinding, plan: frozenPlan(frozen),
    candidateFreezeSha256: hash(candidateFreeze), contrastive, control, confirmations, accuracy,
    superiorityConfirmed: Object.values(confirmations).every(x => x.verdict === 'confirmed'), promotion: 'not-authorized',
    accounting: provider.summary(),
    costByStage: Object.fromEntries(stages.map(stage => [stage, addCosts(provider.telemetry.filter(x => x.stage === stage).map(x => x.costUsd || 0))])),
    telemetry: provider.telemetry, classifications: classifier.log,
    limitations: [
      '40 balanced confirmation cases in 8 selected intents; not full CLINC150 or general agent performance.',
      'Public data may have appeared in model pretraining; local separation does not prove novel data.',
      'Same-process evaluator closure separation is not a malicious-adapter sandbox.',
      'Provider temperature zero does not guarantee bitwise deterministic responses.',
      'The control has equal development ceilings; actual spend and latency differ.',
      'A rejection or unchanged baseline is a valid experiment result. No tuning or retries after confirmation.',
    ] };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length !== 3 || process.argv[2] !== '--live') throw new Error('Explicit --live required; use offline.mjs for zero-network validation.');
  const frozen = await loadFrozen(), source = sourceState();
  const prefix = '/tmp/metaharness-clinc150-confirmation-' + Date.now();
  await save('/tmp/metaharness-clinc150-confirmation-live.lock', { prefix, sourceSha256: source.sourceAndBuildSha256 });
  await save(prefix + '.freeze.json', { createdAt: new Date().toISOString(), source, plan: frozenPlan(frozen) });
  console.log(JSON.stringify({ status: 'frozen', prefix, sourceSha256: source.sourceAndBuildSha256 }));
  let provider;
  try {
    provider = await createProvider();
    const result = await runExperiment(provider, frozen, prefix, { mode: 'live', source });
    await save(prefix + '.result.json', result);
    console.log(JSON.stringify({ status: 'complete', prefix, accounting: result.accounting,
      accuracy: Object.fromEntries(Object.entries(result.accuracy).map(([k, v]) => [k, v.passed + '/40'])),
      verdicts: Object.fromEntries(Object.entries(result.confirmations).map(([k, v]) => [k, v.verdict + ':' + v.reason])) }));
  } catch (error) {
    await save(prefix + '.failure.json', { completed: false, source, plan: frozenPlan(frozen),
      error: error instanceof Error ? error.message : 'run failed',
      accounting: provider?.summary(), telemetry: provider?.telemetry });
    console.error(JSON.stringify({ status: 'failed', prefix, error: error instanceof Error ? error.message : 'run failed' }));
    process.exitCode = 1;
  }
}
