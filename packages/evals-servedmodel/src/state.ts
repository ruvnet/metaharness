// @metaharness/evals-servedmodel — DISTILLATION: promoted MicroLoRA/SONA state → a flywheel policy candidate.
//
// The micro-loop (ruvllm) accumulates real weight-level state per adaptation call — MicroLoRA's `lora_a`/
// `lora_b` matrices + running counters, SONA's EWC++/EMA config + `quality_ema`. ADR-234 §1.1 verified these
// are REAL (samples_seen 1→2, quality_sum 0.9→1.2, quality_ema 0.5→0.5175 across two quality-weighted
// adapts) — not a stub. This module is the pure, deterministic bridge: given a SUMMARY of that live state
// (never the raw multi-megabyte weight matrices — a scalar "weightMagnitude" stands in, same pattern
// weight-eft's TrainConfig uses for LoRA hyperparameters instead of raw tensors), produce a
// `ServedModelPolicyGenome` the flywheel can gate. Distillation never bypasses the gate: it only proposes a
// gen-0-shaped CANDIDATE; promotion still requires clearing `servedModelPromotionRule` on the holdout.
import type { ServedModelPolicyGenome } from './genome.js';
import { rootGenome, clamp01, clampRank, clampInt } from './genome.js';

/** A summary of one MicroLoRA adapter's accumulated state — never the raw lora_a/lora_b tensors. */
export interface MicroLoraStateSummary {
  rank: number;
  scaling: number;
  samplesSeen: number;
  qualitySum: number;
  /** A stand-in scalar for the matrices' accumulated magnitude (e.g. Frobenius norm of lora_a/lora_b). */
  weightMagnitude: number;
}

/** A summary of one SONA config's accumulated state. */
export interface SonaStateSummary {
  hidden: number;
  capacity: number;
  ewcLambda: number;
  emaDecay: number;
  qualityThreshold: number;
  qualityEma: number;
}

export interface PromotedAdaptationState {
  microlora: MicroLoraStateSummary;
  sona: SonaStateSummary;
}

export interface DistillationEligibility {
  eligible: boolean;
  reason: string;
}

/** Gate on samples_seen BEFORE distilling — a state with too few samples is noise, not signal. Pure and
 *  separate from `distillPolicyFromState` so a caller can check eligibility without discarding the state. */
export function checkDistillationEligibility(
  state: PromotedAdaptationState,
  minSamples: number,
): DistillationEligibility {
  if (state.microlora.samplesSeen < minSamples) {
    return {
      eligible: false,
      reason: `samplesSeen ${state.microlora.samplesSeen} < minSamplesForDistillation ${minSamples}`,
    };
  }
  return { eligible: true, reason: 'samplesSeen clears minSamplesForDistillation' };
}

/** Pure mapping: a promoted MicroLoRA/SONA state → a `ServedModelPolicyGenome` candidate. Deterministic —
 *  same state always distills to the same genome, so a replay bundle stays reproducible. `base` supplies the
 *  levers the live state doesn't carry an opinion on (routing/distillation-trigger policy). */
export function distillPolicyFromState(
  state: PromotedAdaptationState,
  base: ServedModelPolicyGenome = rootGenome(),
): ServedModelPolicyGenome {
  // Mean per-sample quality (qualitySum / samplesSeen) informs how much routing depth the distilled
  // policy is willing to spend — a state that has consistently earned high quality feedback can afford a
  // little more routing depth; a low/negative signal should NOT be rewarded with more adaptation surface.
  const meanQuality = state.microlora.samplesSeen > 0 ? state.microlora.qualitySum / state.microlora.samplesSeen : 0;
  const routingDepth = clampInt(base.routingDepth + Math.round(clamp01(meanQuality) * 2), 1, 8);

  // The distilled policy carries the LIVE ewcLambda/emaDecay/qualityThreshold verbatim (clamped) — the
  // whole point is that the flywheel gates the state the micro-loop actually converged to, not a synthetic
  // restatement of it.
  return {
    ...base,
    microloraRank: clampRank(state.microlora.rank),
    ewcLambda: clamp01(state.sona.ewcLambda),
    emaDecay: clamp01(state.sona.emaDecay),
    qualityThreshold: clamp01(state.sona.qualityThreshold),
    routingDepth,
  };
}
