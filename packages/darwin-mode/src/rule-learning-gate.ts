// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';

export interface RuleArtifactBinding { candidateHash: string; programHash: string }
export interface RuleEvaluationRequest {
  runId: string;
  rulebookHash: string;
  candidate: RuleArtifactBinding;
  baseline: RuleArtifactBinding;
  datasetHash: string;
  families: readonly string[];
  seeds: readonly number[];
  maxRegression?: number;
  timeoutMs?: number;
}
export interface RuleHostMeasurement {
  successes: number;
  samples: number;
  replaySteps: number;
  independentProbes: number;
  interactions: number;
  replayMismatches: number;
  failedHiddenProbes: number;
  receiptHash: string;
}
export interface RuleRunContext extends RuleArtifactBinding {
  datasetHash: string;
  family: string;
  seed: number;
  signal: AbortSignal;
}
/** Trusted host capability, never supplied by the candidate. It owns sealed probes,
 * verifies artifact hashes, executes a bounded interpreter, and computes scores.
 * Do not implement this by accepting a candidate's success/score claims.
 */
export type RuleHostRunner = (context: Readonly<RuleRunContext>) => Promise<RuleHostMeasurement>;
export interface RuleGateReport {
  schemaVersion: 1;
  accepted: boolean;
  reasons: string[];
  familyGains: Record<string, number>;
  interactionReduction: number;
  evidenceHash: string;
  ruleLearningEvidence?: Record<string, unknown>;
}
const hashPattern = /^[a-f0-9]{64}$/;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function binding(value: RuleArtifactBinding): RuleArtifactBinding {
  assert(value && hashPattern.test(value.candidateHash) && hashPattern.test(value.programHash), 'invalid artifact binding');
  return { candidateHash: value.candidateHash, programHash: value.programHash };
}
function measurement(value: RuleHostMeasurement): RuleHostMeasurement {
  assert(value && Number.isSafeInteger(value.samples) && value.samples > 0 && Number.isSafeInteger(value.successes) && value.successes >= 0 && value.successes <= value.samples, 'invalid successes/samples');
  assert(Number.isSafeInteger(value.replaySteps) && value.replaySteps > 0 && Number.isSafeInteger(value.independentProbes) && value.independentProbes > 0, 'missing replay/probe evidence');
  for (const key of ['interactions', 'replayMismatches', 'failedHiddenProbes'] as const) {
    assert(Number.isSafeInteger(value[key]) && value[key] >= 0, `invalid ${key}`);
  }
  assert(value.interactions > 0, 'zero interactions');
  assert(hashPattern.test(value.receiptHash), 'invalid receipt hash');
  return { successes: value.successes, samples: value.samples, replaySteps: value.replaySteps, independentProbes: value.independentProbes, interactions: value.interactions, replayMismatches: value.replayMismatches,
    failedHiddenProbes: value.failedHiddenProbes, receiptHash: value.receiptHash };
}

/** Invalid/incomplete evidence throws; callers must treat errors as rejection.
 * This deadline cannot preempt synchronous JS: the trusted host must enforce its
 * own process/worker or interpreter budget and honor AbortSignal cancellation.
 */
export async function evaluateRuleLearning(request: RuleEvaluationRequest, runner: RuleHostRunner): Promise<RuleGateReport> {
  assert(typeof request.runId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(request.runId), 'invalid run ID');
  assert(hashPattern.test(request.rulebookHash), 'invalid rulebook hash');
  const runId = request.runId, rulebookHash = request.rulebookHash;
  const candidate = binding(request.candidate), baseline = binding(request.baseline);
  assert(hashPattern.test(request.datasetHash), 'invalid dataset hash');
  const families = [...request.families].sort(), seeds = [...request.seeds].sort((a, b) => a - b);
  assert(families.length === 3 && new Set(families).size === 3 && families.every(f => /^[a-zA-Z0-9_-]{1,64}$/.test(f)), 'exactly three distinct families required');
  assert(seeds.length === 5 && new Set(seeds).size === 5 && seeds.every(s => Number.isSafeInteger(s) && s >= 0), 'exactly five distinct seeds required');
  const maxRegression = request.maxRegression ?? 0, timeoutMs = request.timeoutMs ?? 1000;
  assert(Number.isFinite(maxRegression) && maxRegression === 0, 'invalid regression bound');
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000, 'invalid timeout');
  const datasetHash = request.datasetHash;
  const evidence: unknown[] = [];
  const reasons = new Set<string>();
  const familyGains = Object.create(null) as Record<string, number>;
  let candidateInteractions = 0, baselineInteractions = 0, passingFamilies = 0;
  let replaySteps = 0, independentProbes = 0, replayMismatches = 0, failedProbes = 0;
  const familyEvidence: Record<string, unknown>[] = [];
  async function run(artifact: RuleArtifactBinding, family: string, seed: number) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return measurement(await Promise.race([
        Promise.resolve().then(() => runner(Object.freeze({ ...artifact, datasetHash, family, seed, signal: controller.signal }))),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('host run deadline exceeded')); }, timeoutMs); }),
      ]));
    } finally { clearTimeout(timer); controller.abort(); }
  }
  for (const family of families) {
    let samples = 0, parentSuccesses = 0, candidateSuccesses = 0, parentInteractions = 0, childInteractions = 0;
    for (const seed of seeds) {
      const observed: RuleHostMeasurement[] = [];
      for (const artifact of [baseline, candidate]) {
        const first = await run(artifact, family, seed), replay = await run(artifact, family, seed);
        if (JSON.stringify(first) !== JSON.stringify(replay)) reasons.add('non-reproducible measurement');
        for (const item of [first, replay]) {
          if (item.replayMismatches !== 0) reasons.add('replay mismatch');
          if (item.failedHiddenProbes !== 0) reasons.add('failed hidden probe');
        }
        observed.push(first);
        evidence.push({ artifact, datasetHash, family, seed, first, replay });
      }
      assert(observed[0].samples === observed[1].samples, 'unmatched evaluation sample counts');
      samples += observed[0].samples; parentSuccesses += observed[0].successes; candidateSuccesses += observed[1].successes;
      parentInteractions += observed[0].interactions; childInteractions += observed[1].interactions;
      replaySteps += observed[1].replaySteps; independentProbes += observed[1].independentProbes;
      replayMismatches += observed[1].replayMismatches; failedProbes += observed[1].failedHiddenProbes;
      assert([samples, parentSuccesses, candidateSuccesses, parentInteractions, childInteractions, replaySteps, independentProbes, replayMismatches, failedProbes].every(Number.isSafeInteger), 'evidence count overflow');
      baselineInteractions += observed[0].interactions;
      candidateInteractions += observed[1].interactions;
      assert(Number.isSafeInteger(baselineInteractions) && Number.isSafeInteger(candidateInteractions), 'interaction count overflow');
    }
    if (BigInt(candidateSuccesses - parentSuccesses) * 5n >= BigInt(samples)) passingFamilies++;
    familyGains[family] = (candidateSuccesses - parentSuccesses) / samples;
    familyEvidence.push({ id: family, seeds, samples, parent_successes: parentSuccesses, candidate_successes: candidateSuccesses, parent_interactions: parentInteractions, candidate_interactions: childInteractions });
    if (familyGains[family] < -maxRegression) reasons.add('family regression');
  }
  const interactionReduction = baselineInteractions > 0 ? 1 - candidateInteractions / baselineInteractions : 0;
  if (passingFamilies < 2) reasons.add('insufficient held-out gain');
  if (baselineInteractions === 0 || BigInt(candidateInteractions) * 4n > BigInt(baselineInteractions) * 3n) reasons.add('insufficient interaction reduction');
  const evidenceHash = createHash('sha256').update(JSON.stringify({ schemaVersion: 1, runId, rulebookHash, candidate, baseline, datasetHash, families, seeds, maxRegression, timeoutMs, evidence })).digest('hex');
  const ruleLearningEvidence = { schema: 'rule-learning-evidence/v1', run_id: runId, candidate_hash: candidate.candidateHash, parent_hash: baseline.candidateHash, rulebook_hash: rulebookHash, executable_hash: candidate.programHash, trace_hash: evidenceHash, hidden_corpus_hash: datasetHash, families: familyEvidence, replay_steps: replaySteps, replay_mismatches: replayMismatches, independent_probes: independentProbes, failed_probes: failedProbes };
  return { schemaVersion: 1, ...(reasons.size === 0 ? { ruleLearningEvidence } : {}), accepted: reasons.size === 0, reasons: [...reasons], familyGains, interactionReduction, evidenceHash };
}
