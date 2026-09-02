import type { BenchmarkArm, EpisodeMetrics, MetricSummary } from './types.js';

export type EpisodeMetric =
  | 'score'
  | 'actionCount'
  | 'model.turnCount'
  | 'simulatedLatencyMs';

interface PairDelta {
  readonly pairId: string;
  readonly clusterId: string;
  readonly delta: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error('cannot calculate a mean of zero values');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) throw new Error('cannot calculate a quantile of zero values');
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function metricValue(episode: EpisodeMetrics, metric: EpisodeMetric): number {
  switch (metric) {
    case 'score': return episode.score;
    case 'actionCount': return episode.actionCount;
    case 'model.turnCount': return episode.model.turnCount;
    case 'simulatedLatencyMs': return episode.simulatedLatencyMs;
  }
}

function pairedDeltas(options: {
  readonly episodes: readonly EpisodeMetrics[];
  readonly challenger: BenchmarkArm;
  readonly baseline: BenchmarkArm;
  readonly metric: EpisodeMetric;
}): readonly PairDelta[] {
  const byPair = new Map<string, Map<BenchmarkArm, EpisodeMetrics>>();
  for (const episode of options.episodes) {
    const arms = byPair.get(episode.pairId) ?? new Map<BenchmarkArm, EpisodeMetrics>();
    if (arms.has(episode.arm)) {
      throw new Error(`duplicate ${episode.arm} episode for pair ${episode.pairId}`);
    }
    arms.set(episode.arm, episode);
    byPair.set(episode.pairId, arms);
  }
  const output: PairDelta[] = [];
  for (const [pairId, arms] of [...byPair].sort(([left], [right]) => left.localeCompare(right))) {
    const challenger = arms.get(options.challenger);
    const baseline = arms.get(options.baseline);
    if (!challenger || !baseline) {
      throw new Error(`pair ${pairId} does not contain both comparison arms`);
    }
    if (challenger.clusterId !== baseline.clusterId) {
      throw new Error(`pair ${pairId} crosses statistical clusters`);
    }
    output.push({
      pairId,
      clusterId: challenger.clusterId,
      delta: metricValue(challenger, options.metric) - metricValue(baseline, options.metric),
    });
  }
  return output;
}

function clusterMeans(deltas: readonly PairDelta[]): readonly number[] {
  const clusters = new Map<string, number[]>();
  for (const item of deltas) {
    const values = clusters.get(item.clusterId) ?? [];
    values.push(item.delta);
    clusters.set(item.clusterId, values);
  }
  return [...clusters].sort(([left], [right]) => left.localeCompare(right))
    .map(([, values]) => mean(values));
}

export function clusteredBootstrapInterval(options: {
  readonly clusterValues: readonly number[];
  readonly resamples: number;
  readonly confidenceLevel: number;
  readonly seed: number;
}): readonly [number, number] {
  if (!Number.isSafeInteger(options.resamples) || options.resamples < 1) {
    throw new TypeError('bootstrap resamples must be a positive integer');
  }
  if (!(options.confidenceLevel > 0 && options.confidenceLevel < 1)) {
    throw new TypeError('confidence level must be between zero and one');
  }
  if (options.clusterValues.length === 0) throw new Error('bootstrap requires at least one cluster');
  const random = mulberry32(options.seed);
  const estimates: number[] = [];
  for (let iteration = 0; iteration < options.resamples; iteration += 1) {
    let total = 0;
    for (let index = 0; index < options.clusterValues.length; index += 1) {
      total += options.clusterValues[Math.floor(random() * options.clusterValues.length)]!;
    }
    estimates.push(total / options.clusterValues.length);
  }
  estimates.sort((left, right) => left - right);
  const alpha = (1 - options.confidenceLevel) / 2;
  return [quantile(estimates, alpha), quantile(estimates, 1 - alpha)];
}

export function signFlipPValue(options: {
  readonly clusterValues: readonly number[];
  readonly resamples: number;
  readonly seed: number;
}): number {
  if (options.clusterValues.length === 0) throw new Error('sign-flip test requires at least one cluster');
  const observed = mean(options.clusterValues);
  const combinations = 2 ** options.clusterValues.length;
  if (Number.isSafeInteger(combinations) && combinations <= options.resamples) {
    let atLeastObserved = 0;
    for (let mask = 0; mask < combinations; mask += 1) {
      let total = 0;
      for (let index = 0; index < options.clusterValues.length; index += 1) {
        total += options.clusterValues[index]! * ((mask & (2 ** index)) === 0 ? -1 : 1);
      }
      if (total / options.clusterValues.length >= observed - Number.EPSILON) {
        atLeastObserved += 1;
      }
    }
    return atLeastObserved / combinations;
  }

  if (!Number.isSafeInteger(options.resamples) || options.resamples < 1) {
    throw new TypeError('permutation resamples must be a positive integer');
  }
  const random = mulberry32(options.seed);
  let atLeastObserved = 0;
  for (let iteration = 0; iteration < options.resamples; iteration += 1) {
    const permuted = mean(options.clusterValues.map(value => random() < 0.5 ? -value : value));
    if (permuted >= observed - Number.EPSILON) atLeastObserved += 1;
  }
  return (atLeastObserved + 1) / (options.resamples + 1);
}

export function summarizePairedMetric(options: {
  readonly episodes: readonly EpisodeMetrics[];
  readonly challenger: BenchmarkArm;
  readonly baseline: BenchmarkArm;
  readonly metric: EpisodeMetric;
  readonly bootstrapResamples: number;
  readonly permutationResamples: number;
  readonly confidenceLevel: number;
  readonly seed: number;
}): MetricSummary {
  const deltas = pairedDeltas(options);
  const clusters = clusterMeans(deltas);
  return Object.freeze({
    nPairs: deltas.length,
    nClusters: clusters.length,
    meanDelta: mean(deltas.map(item => item.delta)),
    confidenceInterval: clusteredBootstrapInterval({
      clusterValues: clusters,
      resamples: options.bootstrapResamples,
      confidenceLevel: options.confidenceLevel,
      seed: options.seed,
    }),
    signFlipPValue: signFlipPValue({
      clusterValues: clusters,
      resamples: options.permutationResamples,
      seed: options.seed ^ 0x9e37_79b9,
    }),
  });
}

export function shuffledArms<T>(values: readonly T[], seed: number): readonly T[] {
  const random = mulberry32(seed);
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target]!, output[index]!];
  }
  return output;
}
