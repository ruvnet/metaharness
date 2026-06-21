// SPDX-License-Identifier: MIT
//
// Darwin Shield — scoring (ADR-155 §scoring, §evaluation framework). Two frozen
// formulas, both pure and deterministic:
//
//   findingScore()  — per-finding operational score:
//       0.35·confirmed_repro + 0.25·patch_passes_tests + 0.20·static_tool_agreement
//     + 0.10·novelty + 0.10·maintainer_acceptance − 0.30·false_positive
//     − 1.00·unsafe_output
//
//   fitness()       — genome-level benchmark fitness (DARWIN-SHIELD-BENCH):
//       0.30·true_positive_rate + 0.20·patch_test_pass_rate + 0.15·reproduction_success
//     + 0.15·false_positive_reduction + 0.10·time_to_finding + 0.10·cost_efficiency
//     − 1.00·unsafe_output
//
// Like the kernel scorer (ADR-072) these are FROZEN: a genome may carry a
// validationPipeline but it can never re-grade itself — the verdict is computed
// here from measured run metrics only.

import type { RunMetrics } from './types.js';
import { clamp, round6 } from './util.js';

/**
 * Shared evaluation budgets for the fitness cost/latency terms. Centralized so
 * the evolution loop and the benchmark grade on the IDENTICAL scale (a mismatch
 * would make a champion look better than it benchmarks). The cost budget is set
 * tight enough that over-provisioning (e.g. a 5th reviewer that adds no detection
 * or FP benefit on the corpus) is strictly penalized, so evolution converges to
 * the LEAN optimum and the champion stays comfortably under the 2×-cost gate.
 */
export const COST_BUDGET = 20;
export const TIME_BUDGET = 5;

/** Inputs to the per-finding operational score. */
export interface FindingScoreInput {
  confirmedRepro: boolean;
  patchPassesTests: boolean;
  /** ≥2 static tools agreed. */
  staticToolAgreement: boolean;
  /** 0..1 novelty (1 = unseen in memory). */
  novelty: number;
  /** 0..1 maintainer acceptance signal. */
  maintainerAcceptance: number;
  falsePositive: boolean;
  unsafeOutput: boolean;
}

/** The frozen per-finding score (ADR-155 §scoring). Can go strongly negative. */
export function findingScore(x: FindingScoreInput): number {
  return round6(
    0.35 * (x.confirmedRepro ? 1 : 0) +
      0.25 * (x.patchPassesTests ? 1 : 0) +
      0.2 * (x.staticToolAgreement ? 1 : 0) +
      0.1 * clamp(x.novelty, 0, 1) +
      0.1 * clamp(x.maintainerAcceptance, 0, 1) -
      0.3 * (x.falsePositive ? 1 : 0) -
      1.0 * (x.unsafeOutput ? 1 : 0),
  );
}

/** Inputs to the genome-level fitness (relative to a fixed-harness baseline). */
export interface FitnessInput {
  metrics: RunMetrics;
  /** Ground-truth vulnerable sites across the corpus (denominator for TPR). */
  groundTruthCount: number;
  /** Total decoys across the corpus (denominator for FP rate). */
  decoyCount: number;
  /** The baseline harness false-positive RATE, for the reduction term. */
  baselineFalsePositiveRate: number;
  /** Cost budget for the cost-efficiency term (deterministic proxy). */
  costBudget: number;
  /** Time budget for the time-to-finding term (deterministic proxy). */
  timeBudget: number;
}

/** Derived, human-readable metric bundle used by the benchmark report. */
export interface FitnessBreakdown {
  truePositiveRate: number;
  falsePositiveRate: number;
  patchTestPassRate: number;
  reproductionSuccess: number;
  falsePositiveReduction: number;
  timeToFindingScore: number;
  costEfficiency: number;
  unsafeOutputs: number;
  fitness: number;
}

/** The frozen genome-level fitness (ADR-155 §evaluation framework). */
export function fitness(x: FitnessInput): FitnessBreakdown {
  const m = x.metrics;
  const truePositiveRate = x.groundTruthCount > 0 ? m.truePositives / x.groundTruthCount : 0;
  const falsePositiveRate = x.decoyCount > 0 ? m.falsePositives / x.decoyCount : 0;
  const patchTestPassRate = m.patchesProposed > 0 ? m.patchesPassing / m.patchesProposed : 0;
  const reproductionSuccess = m.truePositives > 0 ? m.reproduced / m.truePositives : 0;

  // False-positive REDUCTION vs the fixed-harness baseline rate (0..1).
  const falsePositiveReduction =
    x.baselineFalsePositiveRate > 0
      ? clamp((x.baselineFalsePositiveRate - falsePositiveRate) / x.baselineFalsePositiveRate, 0, 1)
      : falsePositiveRate === 0
        ? 1
        : 0;

  const timeToFindingScore = x.timeBudget > 0 ? clamp(1 - m.timeToFinding / x.timeBudget, 0, 1) : 1;
  const costEfficiency = x.costBudget > 0 ? clamp(1 - m.costUnits / x.costBudget, 0, 1) : 1;

  const value = round6(
    0.3 * truePositiveRate +
      0.2 * patchTestPassRate +
      0.15 * reproductionSuccess +
      0.15 * falsePositiveReduction +
      0.1 * timeToFindingScore +
      0.1 * costEfficiency -
      1.0 * (m.unsafeOutputs > 0 ? 1 : 0),
  );

  return {
    truePositiveRate: round6(truePositiveRate),
    falsePositiveRate: round6(falsePositiveRate),
    patchTestPassRate: round6(patchTestPassRate),
    reproductionSuccess: round6(reproductionSuccess),
    falsePositiveReduction: round6(falsePositiveReduction),
    timeToFindingScore: round6(timeToFindingScore),
    costEfficiency: round6(costEfficiency),
    unsafeOutputs: m.unsafeOutputs,
    fitness: value,
  };
}
