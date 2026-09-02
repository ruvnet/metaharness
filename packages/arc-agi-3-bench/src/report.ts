import { hashCanonical } from './canonical.js';
import { summarizePairedMetric } from './stats.js';
import type {
  ArmAggregate,
  BenchmarkArm,
  BenchmarkReport,
  ComparisonReport,
  EpisodeMetrics,
  FrozenBenchmarkManifest,
} from './types.js';

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error('cannot aggregate an empty arm');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregate(episodes: readonly EpisodeMetrics[], arm: BenchmarkArm): ArmAggregate {
  const selected = episodes.filter(episode => episode.arm === arm);
  if (selected.length === 0) throw new Error(`no episodes for arm ${arm}`);
  return Object.freeze({
    episodes: selected.length,
    meanScore: mean(selected.map(episode => episode.score)),
    winRate: mean(selected.map(episode => episode.finalState === 'WIN' ? 1 : 0)),
    meanActions: mean(selected.map(episode => episode.actionCount)),
    meanModelTurns: mean(selected.map(episode => episode.model.turnCount)),
    meanTotalUsageUnits: mean(selected.map(episode => episode.model.totalUsageUnits)),
    meanSimulatedLatencyMs: mean(selected.map(episode => episode.simulatedLatencyMs)),
    allReceiptsValid: selected.every(episode => episode.receiptVerification.ok),
  });
}

function compare(options: {
  readonly episodes: readonly EpisodeMetrics[];
  readonly manifest: FrozenBenchmarkManifest;
  readonly challenger: BenchmarkArm;
  readonly baseline: BenchmarkArm;
  readonly seedOffset: number;
}): ComparisonReport {
  const common = {
    episodes: options.episodes,
    challenger: options.challenger,
    baseline: options.baseline,
    bootstrapResamples: options.manifest.statistics.bootstrapResamples,
    permutationResamples: options.manifest.statistics.permutationResamples,
    confidenceLevel: options.manifest.statistics.confidenceLevel,
  } as const;
  const seed = options.manifest.statistics.randomSeed ^ options.seedOffset;
  return Object.freeze({
    challenger: options.challenger,
    baseline: options.baseline,
    score: summarizePairedMetric({ ...common, metric: 'score', seed }),
    actions: summarizePairedMetric({ ...common, metric: 'actionCount', seed: seed ^ 0x1001 }),
    modelTurns: summarizePairedMetric({ ...common, metric: 'model.turnCount', seed: seed ^ 0x2002 }),
    simulatedLatencyMs: summarizePairedMetric({
      ...common,
      metric: 'simulatedLatencyMs',
      seed: seed ^ 0x3003,
    }),
  });
}

export function buildBenchmarkReport(options: {
  readonly manifest: FrozenBenchmarkManifest;
  readonly fixtureSuiteHash: string;
  readonly randomizedOrders: readonly {
    readonly pairId: string;
    readonly order: readonly BenchmarkArm[];
  }[];
  readonly episodes: readonly EpisodeMetrics[];
  readonly generatedAt?: string;
}): BenchmarkReport {
  if (options.fixtureSuiteHash !== options.manifest.fixtureSuiteHash) {
    throw new Error('fixture suite hash changed after manifest freeze');
  }
  const aggregates = Object.freeze({
    direct: aggregate(options.episodes, 'direct'),
    'direct-reflection': aggregate(options.episodes, 'direct-reflection'),
    avo: aggregate(options.episodes, 'avo'),
  });
  const avoVsDirect = compare({
    episodes: options.episodes,
    manifest: options.manifest,
    challenger: 'avo',
    baseline: 'direct',
    seedOffset: 0x101,
  });
  const avoVsDirectReflection = compare({
    episodes: options.episodes,
    manifest: options.manifest,
    challenger: 'avo',
    baseline: 'direct-reflection',
    seedOffset: 0x202,
  });
  const primary = avoVsDirectReflection.score;
  const allReceiptsValid = Object.values(aggregates).every(value => value.allReceiptsValid);
  const fingerprintsByPair = new Map<string, Set<string>>();
  for (const episode of options.episodes) {
    const values = fingerprintsByPair.get(episode.pairId) ?? new Set<string>();
    values.add(episode.initialObservationFingerprint);
    fingerprintsByPair.set(episode.pairId, values);
  }
  const computeProtocolMatched = options.episodes.every(episode => {
    if (episode.arm === 'direct-reflection') {
      return episode.model.planTurns === episode.actionCount
        && episode.model.reflectionTurns === episode.actionCount
        && episode.model.supervisorTurns === 0
        && episode.model.turnCount === episode.actionCount * 2;
    }
    if (episode.arm === 'avo') {
      return episode.model.planTurns === episode.actionCount
        && episode.model.reflectionTurns + episode.model.supervisorTurns === episode.actionCount
        && episode.model.turnCount === episode.actionCount * 2;
    }
    return true;
  });
  const reflectionByPair = new Map(
    options.episodes
      .filter(episode => episode.arm === 'direct-reflection')
      .map(episode => [episode.pairId, episode] as const),
  );
  // Bound declared per-turn compute as well as call-slot counts. File-broker
  // usage is still operator-reported; a claim-eligible provider run needs a
  // separately verified provider evidence integration.
  const computeUsageBounded = options.episodes
    .filter(episode => episode.arm === 'avo')
    .every(episode => {
      const control = reflectionByPair.get(episode.pairId);
      if (!control || episode.model.turnCount < 1 || control.model.turnCount < 1) return false;
      const avoPerTurn = episode.model.totalUsageUnits / episode.model.turnCount;
      const controlPerTurn = control.model.totalUsageUnits / control.model.turnCount;
      return Number.isFinite(avoPerTurn)
        && Number.isFinite(controlPerTurn)
        && controlPerTurn > 0
        && avoPerTurn <= controlPerTurn * 1.25;
    });
  const checks = Object.freeze({
    meanScoreDelta: primary.meanDelta >= options.manifest.acceptance.minimumMeanScoreDelta,
    confidenceLowerBound: !options.manifest.acceptance.requireConfidenceLowerBoundAboveZero
      || primary.confidenceInterval[0] > 0,
    permutationPValue: primary.signFlipPValue
      <= options.manifest.acceptance.maximumPermutationPValue,
    receiptIntegrity: !options.manifest.acceptance.requireAllReceiptChainsValid
      || allReceiptsValid,
    pairedInitialObservations: [...fingerprintsByPair.values()]
      .every(fingerprints => fingerprints.size === 1),
    completeModelUsage: options.episodes.every(episode => episode.model.usageComplete),
    noFailedModelCalls: options.episodes.every(episode => episode.model.failedTurnCount === 0),
    computeProtocolMatched,
    computeUsageBounded,
    noEpisodeErrors: options.episodes.every(episode => episode.stoppedReason !== 'ERROR'),
  });
  const deterministicEpisodes = options.episodes.map(episode => {
    const { elapsedWallMs: _observedWallDiagnostic, ...evidence } = episode;
    return evidence;
  });
  const deterministicEvidenceHash = hashCanonical({
    manifest: options.manifest,
    fixtureSuiteHash: options.fixtureSuiteHash,
    randomizedOrders: options.randomizedOrders,
    episodes: deterministicEpisodes,
    aggregates,
    comparisons: { avoVsDirect, avoVsDirectReflection },
    acceptance: { passed: Object.values(checks).every(Boolean), checks },
  });
  const body = Object.freeze({
    schema: 'metaharness.arc_agi_3.benchmark_report.v1' as const,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    manifest: options.manifest,
    fixtureSuiteHash: options.fixtureSuiteHash,
    randomizedOrders: Object.freeze(options.randomizedOrders.map(value => Object.freeze({
      pairId: value.pairId,
      order: Object.freeze([...value.order]),
    }))),
    episodes: Object.freeze([...options.episodes]),
    aggregates,
    comparisons: Object.freeze({ avoVsDirect, avoVsDirectReflection }),
    acceptance: Object.freeze({
      passed: Object.values(checks).every(Boolean),
      checks,
    }),
    limitations: Object.freeze([
      'This constructed deterministic mechanism fixture is not an official ARC-AGI-3 score or a general intelligence measurement.',
      'The scripted driver intentionally repeats the first action in direct arms; the result validates runner wiring and governed variation, not model quality.',
      'The compute-matched control freezes the same driver, seed, per-decision reflection/deliberation calls, and maximum turn budget; terminal episodes legitimately consume fewer calls.',
      'File-broker model identity, sampling settings, latency, and usage are operator-declared; this runner does not authenticate provider receipts.',
      'Observed wall time is recorded per episode but excluded from deterministic acceptance because local scheduling noise is uncontrolled.',
    ]),
    deterministicEvidenceHash,
  });
  return Object.freeze({ ...body, reportHash: hashCanonical(body) });
}
