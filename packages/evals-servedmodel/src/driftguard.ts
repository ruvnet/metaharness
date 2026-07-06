// @metaharness/evals-servedmodel — the DRIFT-RISK detector (fail-closed).
//
// The domain-specific analog of evals-hle's leakage detector: instead of scanning for benchmark artifacts,
// this scans the GENOME ITSELF for combinations that are structurally likely to cause catastrophic
// forgetting — the failure mode ADR-234 §3 names as the reason two independent guards exist (EWC++ at the
// weights level, the flywheel anchor at the programmatic level). This is the WEIGHTS-LEVEL guard's sanity
// check, expressed as a static, genome-only property (no data needed) — any positive signal marks the
// candidate `regressed` so the frozen gate rejects it outright, BEFORE the (separately measured) anchor
// suite even gets a chance to catch it. Defense in depth, matching ADR-234's "two independent guards".
import type { ServedModelPolicyGenome } from './genome.js';
import { adaptationAggressiveness } from './genome.js';

/** Below this, EWC++ is not meaningfully penalizing drift at all — a serving policy in this band with any
 *  non-'off' adaptation mode is treated as an unguarded write path onto prior weights. */
export const EWC_SAFETY_FLOOR = 0.05;
/** 'aggressive' mode compounds many high-magnitude updates per request; it needs a materially higher floor
 *  than the baseline safety floor to keep the stability/plasticity tradeoff (ADR-234 §5, limit 4) honest. */
export const AGGRESSIVE_EWC_FLOOR = 0.15;
/** Full routing depth with no forgetting guard maximizes the surface a single request can perturb. */
export const MAX_ROUTING_DEPTH = 8;

export interface DriftRisk {
  /** ewcLambda below the baseline safety floor while adaptation is not disabled. */
  ewcTooLow: boolean;
  /** 'aggressive' mode combined with ewcLambda below the (higher) aggressive-mode floor. */
  aggressiveWithoutEwc: boolean;
  /** Full memory-routing depth combined with a below-floor ewcLambda — maximal blast radius. */
  routingDepthUnguarded: boolean;
}

export function detectDriftRisk(genome: ServedModelPolicyGenome): DriftRisk {
  const adapting = genome.adaptationMode !== 'off';
  const ewcTooLow = adapting && genome.ewcLambda < EWC_SAFETY_FLOOR;
  const aggressiveWithoutEwc =
    genome.adaptationMode === 'aggressive' && genome.ewcLambda < AGGRESSIVE_EWC_FLOOR;
  const routingDepthUnguarded =
    genome.routingDepth >= MAX_ROUTING_DEPTH && genome.ewcLambda < EWC_SAFETY_FLOOR && adapting;
  return { ewcTooLow, aggressiveWithoutEwc, routingDepthUnguarded };
}

/** Fail-closed verdict: true if the candidate must be rejected outright, before any measured anchor check. */
export function driftRisky(risk: DriftRisk): boolean {
  return risk.ewcTooLow || risk.aggressiveWithoutEwc || risk.routingDepthUnguarded;
}

/** A scalar "drift pressure" estimate — how hard this genome's settings push against retained capability,
 *  net of the EWC++ guard. Used ONLY by the synthetic mock evaluator/benchmark to model plausible dynamics;
 *  never fed back into `driftRisky` (which must stay a pure structural gate, not a measured one). */
export function driftPressure(genome: ServedModelPolicyGenome): number {
  const rankPressure = (genome.microloraRank - 1) / 3; // [0,1]
  const depthPressure = (genome.routingDepth - 1) / (MAX_ROUTING_DEPTH - 1); // [0,1]
  const modePressure = adaptationAggressiveness(genome.adaptationMode) / 3; // [0,1]
  const raw = (rankPressure + depthPressure + modePressure) / 3; // [0,1]
  return raw * (1 - genome.ewcLambda);
}
