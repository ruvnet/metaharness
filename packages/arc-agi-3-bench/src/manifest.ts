import { assertSha256, hashCanonical } from './canonical.js';
import type {
  FrozenBenchmarkManifest,
  FrozenBenchmarkManifestBody,
  FrozenModelConfig,
} from './types.js';

export const DIRECT_PROMPT = [
  'Choose exactly one offered ARC action.',
  'Use only the current exact observation.',
  'Return a concise public hypothesis and confidence.',
].join('\n');

export const REFLECTION_PROMPT = [
  'Review the current observation and visible transition evidence.',
  'State concise public advice before choosing one action.',
  'Do not claim hidden game knowledge.',
].join('\n');

export const AVO_PROMPT = [
  'Generate bounded alternative action candidates from the exact observation.',
  'Use the governed memory and frontier only when the configured arm exposes them.',
  'Attach a concise public hypothesis and falsifiable expectation to each candidate.',
].join('\n');

export const SUPERVISOR_PROMPT = [
  'Review only the typed supervisor case bundle.',
  'Return a bounded typed directive; never submit an environment action.',
  'Cite receipt hashes for any required evidence.',
].join('\n');

const TOOL_SCHEMA = {
  request: {
    kinds: ['PLAN', 'REFLECT', 'SUPERVISE'],
    actionNames: ['RESET', 'ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION5', 'ACTION6', 'ACTION7'],
  },
  response: {
    candidateActions: 'array',
    reflection: 'string',
    supervisorDirective: 'typed-object',
  },
};

export function freezeManifest(body: FrozenBenchmarkManifestBody): FrozenBenchmarkManifest {
  return Object.freeze({ ...body, manifestHash: hashCanonical(body) });
}

export function assertFrozenManifest(value: FrozenBenchmarkManifest): void {
  if (value.schema !== 'metaharness.arc_agi_3.benchmark_manifest.v1') {
    throw new TypeError('unsupported benchmark manifest schema');
  }
  assertSha256(value.fixtureSuiteHash, 'fixtureSuiteHash');
  assertSha256(value.manifestHash, 'manifestHash');
  const { manifestHash, ...body } = value;
  const actual = hashCanonical(body);
  if (actual !== manifestHash) {
    throw new Error(`benchmark manifest hash mismatch: expected ${manifestHash}, got ${actual}`);
  }
  if (value.officialArcScore || value.claimEligible) {
    throw new Error('the deterministic mechanism fixture cannot be claim-eligible');
  }
  if (value.arms.join(',') !== 'direct,direct-reflection,avo') {
    throw new Error('benchmark arms or their frozen order changed');
  }
  if (new Set(value.episodeSeeds).size !== value.episodeSeeds.length) {
    throw new Error('episode seeds must be unique');
  }
}

export function createDefaultManifest(options: {
  readonly fixtureSuiteId: string;
  readonly fixtureSuiteHash: string;
  readonly model?: Partial<FrozenModelConfig>;
}): FrozenBenchmarkManifest {
  const model: FrozenModelConfig = Object.freeze({
    driver: options.model?.driver ?? 'scripted-v1',
    visibleModelLabel: options.model?.visibleModelLabel ?? 'scripted-mechanism-driver-v1',
    modelId: options.model?.modelId ?? 'scripted-mechanism-driver-v1',
    modelSeed: options.model?.modelSeed ?? 1729,
    temperature: options.model?.temperature ?? 0,
    reasoningEffort: options.model?.reasoningEffort ?? 'fixed-script',
    operatorDeclaredIdentity: options.model?.operatorDeclaredIdentity ?? false,
  });
  const body: FrozenBenchmarkManifestBody = Object.freeze({
    schema: 'metaharness.arc_agi_3.benchmark_manifest.v1',
    benchmarkId: 'arc-avo-causal-escape-v1',
    benchmarkKind: 'offline-deterministic-mechanism',
    officialArcScore: false,
    claimEligible: false,
    claimBoundary: 'Synthetic mechanism validation only; it is not an ARC-AGI-3 intelligence or leaderboard result.',
    fixtureSuiteId: options.fixtureSuiteId,
    fixtureSuiteHash: options.fixtureSuiteHash,
    arms: Object.freeze(['direct', 'direct-reflection', 'avo'] as const),
    armOrderSeed: 0x0a70_251,
    episodeSeeds: Object.freeze([11, 29, 47]),
    budgets: Object.freeze({
      maxActions: 8,
      maxModelTurns: 24,
      maxWallTimeMs: 60_000,
    }),
    controller: Object.freeze({
      version: 'arc-controller+arc-avo-loop-v1',
      supervisorThresholds: Object.freeze({
        repeatedEdgeCount: 2,
        noEffectCount: 6,
        noEffectWindow: 8,
        predictionErrorMean: 0.9,
        predictionErrorWindow: 8,
        stagnationWindow: 8,
        cycleWithinComponentCount: 8,
        coordinateProbeCount: 8,
      }),
    }),
    model,
    prompts: Object.freeze({
      directHash: hashCanonical(DIRECT_PROMPT),
      reflectionHash: hashCanonical(REFLECTION_PROMPT),
      avoHash: hashCanonical(AVO_PROMPT),
      supervisorHash: hashCanonical(SUPERVISOR_PROMPT),
    }),
    toolSchemaHash: hashCanonical(TOOL_SCHEMA),
    environmentAdapterVersion: 'arc-agi-3-bench/mechanism-environment-v1',
    statistics: Object.freeze({
      bootstrapResamples: 10_000,
      permutationResamples: 100_000,
      confidenceLevel: 0.95,
      randomSeed: 0x51a7_1571,
      clusterUnit: 'fixture-task',
      alternative: 'avo-greater',
    }),
    acceptance: Object.freeze({
      primaryComparison: 'avo-vs-direct-reflection',
      minimumMeanScoreDelta: 10,
      requireConfidenceLowerBoundAboveZero: true,
      maximumPermutationPValue: 0.05,
      requireAllReceiptChainsValid: true,
    }),
  });
  const frozen = freezeManifest(body);
  assertFrozenManifest(frozen);
  return frozen;
}
