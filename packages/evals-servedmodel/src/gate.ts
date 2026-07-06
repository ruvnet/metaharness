// @metaharness/evals-servedmodel — the SERVED-MODEL COMPOSITE PROMOTION GATE (ADR-234).
//
// CRITICAL INTEGRITY PROPERTY (unchanged from evals-hle): the flywheel's default `meetsPromotionRule` is
// FROZEN and is NOT edited here. This gate CALLS the frozen rule VERBATIM and ANDs stricter, served-model-
// specific clauses — a strict superset, never a replacement. The replay bundle fingerprints WHATEVER rule
// ran, so this composite is itself frozen + verifiably unchanged for the ruvllm deployment.
//
// Served-model extras (all must hold, ON TOP of every frozen clause) — this is the flywheel's half of
// ADR-234 §3's "two independent guards": structural drift risk (driftguard.ts, checked pre-measurement) AND
// the measured retained-capability check below (post-measurement, using the 'core' items' quality).
//   structural forgetting guard    candidate.driftRisk === false  (driftguard.ts fired ⇒ reject outright)
//   retained-capability guard       candidate.coreMeanQuality ≥ baseline.coreMeanQuality − CORE_TOLERANCE
//   commit-rate guard (product)    candidate.noCommitRate ≤ baseline.noCommitRate (redundant with the base
//                                   gate's noopRate clause but named explicitly for the ruvllm domain)
//   latency guard                  candidate.latencyMsP50 ≤ baseline.latencyMsP50 * MAX_LATENCY_GROWTH
import { meetsPromotionRule } from '@metaharness/flywheel';
import type { PromotionEvidence, PromotionDecision } from '@metaharness/flywheel';
import type { ServedModelScore } from './score.js';

/** A promoted policy may not erode 'core' (retained-capability) quality by more than this much — the
 *  numerical tolerance around "must not regress" that accounts for finite-sample noise on a small anchor. */
export const CORE_TOLERANCE = 0.005;
/** ruvllm's Rust/SIMD routing is supposed to stay a few ms (ADR-234 §4); a serving policy that lets p50
 *  latency balloon past this multiple of baseline is a product regression even if quality improved. */
export const MAX_LATENCY_GROWTH = 1.5;

/** The composite served-model gate. `evidence.baseline`/`candidate` MUST be ServedModelScore. */
export function servedModelPromotionRule(evidence: PromotionEvidence): PromotionDecision {
  // 1) the FROZEN default gate — untouched, called verbatim.
  const base = meetsPromotionRule(evidence);
  const reasons = [...base.reasons];

  const b = evidence.baseline as ServedModelScore;
  const c = evidence.candidate as ServedModelScore;

  // 2) served-model extras (guard for the case a plain Score slips through).
  if (typeof c.coreMeanQuality === 'number' && typeof b.coreMeanQuality === 'number') {
    if (c.driftRisk) reasons.push('structural_drift_risk');
    if (c.coreMeanQuality < b.coreMeanQuality - CORE_TOLERANCE) reasons.push('core_capability_regressed');
    if (c.noCommitRate > b.noCommitRate) reasons.push('commit_rate_worsened');
    if (typeof c.latencyMsP50 === 'number' && typeof b.latencyMsP50 === 'number' && b.latencyMsP50 > 0) {
      if (c.latencyMsP50 > b.latencyMsP50 * MAX_LATENCY_GROWTH) reasons.push('latency_regressed');
    }
  }

  return { promote: reasons.length === 0, reasons };
}
