// SPDX-License-Identifier: MIT
//
// @metaharness/projects — opportunity.ts (ADR-165 Darwin Opportunity Scanner).
//
// Borrows CrewAI's "Discovery" idea: before you spend evolution budget, find WHERE
// it pays off. This module ranks automation opportunities by ROI so that Darwin's
// mutation budget flows to task classes where (a) model spend is high (lots to save)
// AND (b) verification is strong (savings are real, not hallucinated). Each top
// recommendation carries the four numbers a human needs to greenlight it:
// estimated monthly cost, expected saving, verification method, and risk score.
//
// The optimization (measured in bench/opportunity.bench.mjs): a naive "automate the
// highest-spend task class first" strategy ignores verification, so its expected
// realized saving is low (weak oracles let regressions through, eroding the saving).
// ROI ranking — saving discounted by risk — recovers more realized saving from the
// same budget. The bench reports the realized-saving uplift of ROI vs spend-only.
//
// Fully deterministic: pure arithmetic, round6 for canonical precision, no RNG/clock.

import { clamp, round6 } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// Verification methods, inputs, and scores.
// ─────────────────────────────────────────────────────────────────────────────

/** How an automated task class's output is verified — strongest to weakest. */
export type VerificationMethod = 'real-oracle' | 'unit-tests' | 'human-review' | 'none';

/**
 * One candidate task class to (maybe) automate. The 0..1 fields are pre-normalized
 * signals; monthlyVolume and modelSpendUnitsPerTask are raw magnitudes.
 */
export interface OpportunityInput {
  taskClass: string;
  /** How many times per month this task runs. */
  monthlyVolume: number;
  /** Model cost-units spent per single task execution. */
  modelSpendUnitsPerTask: number;
  /** 0..1 — how trustworthy the available verification signal is. */
  verificationStrength: number;
  /** 0..1 — probability an automated run goes wrong undetected. */
  failureRisk: number;
  /** 0..1 — how hard the task is for a model (higher = harder to automate well). */
  modelComplexity: number;
  /** 0..1 — how easy it is to write a deterministic check for the output. */
  testability: number;
}

/** A scored opportunity. `rank` is assigned by rankOpportunities (1 = best ROI). */
export interface OpportunityScore {
  taskClass: string;
  /** 0..1 — intrinsic attractiveness of automating (value × testability). */
  automationValue: number;
  /** 0..1 — fraction of the monthly cost that automation could realistically save. */
  costSavingPotential: number;
  /** Raw monthly model spend on this task class (volume × per-task spend). */
  estimatedMonthlyCost: number;
  /** Risk-discounted monthly saving (always in [0, estimatedMonthlyCost]). */
  expectedSaving: number;
  /** Verification method derived from verificationStrength. */
  verificationMethod: VerificationMethod;
  /** 0..1 — combined failure + weak-verification risk. */
  riskScore: number;
  /** The ranking statistic: expectedSaving weighted down by riskScore. */
  roi: number;
  /** 1-based rank after sorting by roi desc. */
  rank: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring (pure, deterministic).
// ─────────────────────────────────────────────────────────────────────────────

/** Map a 0..1 verification strength to the strongest method it can support. */
function methodFor(verificationStrength: number): VerificationMethod {
  if (verificationStrength >= 0.8) return 'real-oracle';
  if (verificationStrength >= 0.5) return 'unit-tests';
  if (verificationStrength >= 0.2) return 'human-review';
  return 'none';
}

/**
 * Score a single opportunity (rank omitted — assigned later by rankOpportunities).
 *
 * Derivations:
 *   estimatedMonthlyCost = monthlyVolume × modelSpendUnitsPerTask           (raw spend)
 *   spendWeight          = 1 − 1/(1 + cost/SCALE)                           (0..1, saturating)
 *   costSavingPotential  = spendWeight × testability × verificationStrength (0..1)
 *   automationValue      = mean(spendWeight, testability) × (1 − complexity)(0..1)
 *   riskScore            = mean(failureRisk, 1 − verificationStrength)      (0..1)
 *   expectedSaving       = estimatedMonthlyCost × costSavingPotential × (1 − failureRisk)
 *   roi                  = expectedSaving × (1 − 0.7 × riskScore)           (risk-discounted)
 */
export function scoreOpportunity(i: OpportunityInput): Omit<OpportunityScore, 'rank'> {
  // Clamp the normalized inputs defensively so out-of-range data can't escape bounds.
  const verificationStrength = clamp(i.verificationStrength, 0, 1);
  const failureRisk = clamp(i.failureRisk, 0, 1);
  const modelComplexity = clamp(i.modelComplexity, 0, 1);
  const testability = clamp(i.testability, 0, 1);

  // Raw monthly spend (non-negative; magnitudes are not normalized).
  const estimatedMonthlyCost = round6(Math.max(0, i.monthlyVolume) * Math.max(0, i.modelSpendUnitsPerTask));

  // Saturating 0..1 weight: more spend → more to save, with diminishing influence.
  // SCALE sets the spend at which spendWeight crosses 0.5.
  const SCALE = 500;
  const spendWeight = 1 - 1 / (1 + estimatedMonthlyCost / SCALE);

  // Higher when spend is high AND the output is both testable and well-verified.
  const costSavingPotential = clamp(spendWeight * testability * verificationStrength, 0, 1);

  // Intrinsic attractiveness: worth × ease, penalized by raw model complexity.
  const automationValue = clamp(((spendWeight + testability) / 2) * (1 - modelComplexity), 0, 1);

  // Risk rises with intrinsic failure risk and with WEAK verification (1 − strength).
  const riskScore = clamp((failureRisk + (1 - verificationStrength)) / 2, 0, 1);

  // Expected realized saving: the slice of spend we can save, discounted for failures.
  const expectedSavingRaw = estimatedMonthlyCost * costSavingPotential * (1 - failureRisk);
  // Guarantee the contract: 0 <= expectedSaving <= estimatedMonthlyCost.
  const expectedSaving = round6(clamp(expectedSavingRaw, 0, estimatedMonthlyCost));

  // ROI is the saving you can bank, weighted down by how risky banking it is.
  const roi = round6(expectedSaving * (1 - 0.7 * riskScore));

  return {
    taskClass: i.taskClass,
    automationValue: round6(automationValue),
    costSavingPotential: round6(costSavingPotential),
    estimatedMonthlyCost,
    expectedSaving,
    verificationMethod: methodFor(verificationStrength),
    riskScore: round6(riskScore),
    roi,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranking.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score every input and rank by ROI descending. Ties broken stably by taskClass
 * (lexicographic) so the order is fully deterministic for a fixed portfolio.
 * Ranks are assigned 1..n after sorting.
 */
export function rankOpportunities(items: OpportunityInput[]): OpportunityScore[] {
  const scored = items.map((it) => ({ ...scoreOpportunity(it), rank: 0 }));
  scored.sort((a, b) => {
    if (b.roi !== a.roi) return b.roi - a.roi; // higher ROI first
    return a.taskClass < b.taskClass ? -1 : a.taskClass > b.taskClass ? 1 : 0; // stable tiebreak
  });
  for (let r = 0; r < scored.length; r += 1) scored[r].rank = r + 1;
  return scored;
}
