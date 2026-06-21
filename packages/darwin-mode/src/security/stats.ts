// SPDX-License-Identifier: MIT
//
// Darwin Shield — statistical promotion (ADR-155 §ADR addendum; grounded in
// ADR-079 SGM). "Darwin Mode will not be accepted as self-improving unless the
// champion beats the previous champion AND all baselines" — and a point estimate
// is not a proof. A child is "really" better only when the lower 95% bound on the
// bootstrapped per-repo score delta is above zero (not one lucky repo).
//
// Seeded (mulberry32) ⇒ byte-reproducible verdict from a clean checkout, so the
// statistical gate itself satisfies the reproducibility clause. Pure, no I/O.

import type { Corpus } from './corpus.js';
import type { HarnessGenome } from './types.js';
import { fitness } from './scoring.js';
import { COST_BUDGET, TIME_BUDGET } from './scoring.js';
import { groundTruth, decoys } from './corpus.js';
import { runSwarmPerRepo } from './swarm.js';
import { makeRng, round6 } from './util.js';

/** Per-repo fitness samples for a genome — the distribution the gate uses. */
export function perRepoFitness(
  genome: HarnessGenome,
  corpus: Corpus,
  baselineFalsePositiveRate: number,
): number[] {
  const perRepo = runSwarmPerRepo(genome, corpus);
  return corpus.repos.map((repo, i) => {
    const gt = repo.sites.filter((s) => s.isVulnerable).length;
    const dc = repo.sites.filter((s) => !s.isVulnerable).length;
    return fitness({
      metrics: perRepo[i].metrics,
      groundTruthCount: gt,
      decoyCount: dc,
      baselineFalsePositiveRate,
      costBudget: COST_BUDGET,
      timeBudget: TIME_BUDGET,
    }).fitness;
  });
}

export interface BootstrapResult {
  meanDelta: number;
  lower95: number;
  upper95: number;
  /** meanDelta > minDelta ∧ lower95 > 0. */
  promote: boolean;
  samples: number;
  /** One-sided bootstrap p-value for H0: delta ≤ 0. */
  pValue: number;
}

/**
 * Seeded bootstrap over the previous→new per-repo score deltas. PAIRED by repo:
 * each repo is a matched unit (same code, same difficulty), so the correct
 * statistic is the per-repo delta `new[i] − prev[i]`, resampled with replacement
 * over repos. This controls for repo difficulty — an unpaired (cross-product)
 * bootstrap would spuriously compare the champion's hardest repo against the
 * baseline's easiest. Falls back to the unpaired estimator when the two arrays
 * are not aligned (different lengths). Draws `samples` resampled mean-deltas;
 * `promote` requires a meaningful mean AND a lower-95% bound above zero.
 */
export function bootstrapDelta(
  prevScores: number[],
  newScores: number[],
  opts?: { samples?: number; seed?: number; minDelta?: number },
): BootstrapResult {
  const samples = opts?.samples ?? 5000;
  const seed = opts?.seed ?? 0;
  const minDelta = opts?.minDelta ?? 0;

  if (prevScores.length === 0 || newScores.length === 0) {
    return { meanDelta: 0, lower95: 0, upper95: 0, promote: false, samples, pValue: 1 };
  }

  const rng = makeRng(seed);
  const deltas = new Array<number>(samples);
  let sum = 0;
  let nonPositive = 0;
  const paired = prevScores.length === newScores.length;
  const n = paired ? prevScores.length : 0;

  for (let i = 0; i < samples; i += 1) {
    let delta: number;
    if (paired) {
      // Resample repos with replacement; average the per-repo paired deltas.
      let acc = 0;
      for (let j = 0; j < n; j += 1) {
        const idx = Math.floor(rng() * n);
        acc += newScores[idx] - prevScores[idx];
      }
      delta = acc / n;
    } else {
      const prev = prevScores[Math.floor(rng() * prevScores.length)];
      const next = newScores[Math.floor(rng() * newScores.length)];
      delta = next - prev;
    }
    deltas[i] = delta;
    sum += delta;
    if (delta <= 0) nonPositive += 1;
  }
  deltas.sort((x, y) => x - y);

  const meanDelta = round6(sum / samples);
  const lower95 = round6(deltas[Math.floor(samples * 0.025)]);
  const upper95 = round6(deltas[Math.floor(samples * 0.975)]);
  const promote = meanDelta > minDelta && lower95 > 0;
  const pValue = round6(nonPositive / samples);
  return { meanDelta, lower95, upper95, promote, samples, pValue };
}

export interface PromotionDecision {
  promote: boolean;
  reasons: string[];
  meanDelta: number;
  lower95: number;
  newMeanFitness: number;
  prevMeanFitness: number;
  /** New harness must not regress on safety (zero unsafe across repos). */
  unsafeRegression: boolean;
  pValue: number;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * The full champion-vs-(previous champion | baseline) promotion verdict
 * (ADR-155 addendum). The new harness is admitted only when it is statistically
 * superior (lower-95% delta > 0) AND introduces no unsafe-output regression.
 */
export function decidePromotion(
  prevGenome: HarnessGenome,
  newGenome: HarnessGenome,
  corpus: Corpus,
  baselineFalsePositiveRate: number,
  opts?: { samples?: number; seed?: number; minDelta?: number },
): PromotionDecision {
  const prevScores = perRepoFitness(prevGenome, corpus, baselineFalsePositiveRate);
  const newScores = perRepoFitness(newGenome, corpus, baselineFalsePositiveRate);
  const boot = bootstrapDelta(prevScores, newScores, opts);

  // Safety regression check: the new harness must emit zero unsafe outputs.
  const newPerRepo = runSwarmPerRepo(newGenome, corpus);
  const unsafeRegression = newPerRepo.some((r) => r.metrics.unsafeOutputs > 0);

  const reasons: string[] = [];
  if (!boot.promote) reasons.push(`not statistically superior (lower95 ${boot.lower95} ≤ 0)`);
  if (unsafeRegression) reasons.push('unsafe-output regression');

  const promote = boot.promote && !unsafeRegression;
  if (promote) reasons.push(`promoted: lower95 ${boot.lower95} > 0, meanDelta ${boot.meanDelta}, zero unsafe`);

  return {
    promote,
    reasons,
    meanDelta: boot.meanDelta,
    lower95: boot.lower95,
    newMeanFitness: round6(mean(newScores)),
    prevMeanFitness: round6(mean(prevScores)),
    unsafeRegression,
    pValue: boot.pValue,
  };
}
