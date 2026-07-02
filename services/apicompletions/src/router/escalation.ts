// Confidence-driven escalation (ADR-203 §3.3, §6.5) — NON-STREAMING (post_hoc) only.
// τ is INTERNAL + adaptive, MetaHarness-owned, NEVER a public input. Streams route once
// up front (stream_oneshot) on the input signal; they do NOT run post-gen escalation.
import type { Tier } from '../types/openai';
import { nextTierUp, tierRank } from '../tier/resolveTier';

export interface VerifierResult {
  /** Internal self-confidence in [0,1]; compared against the internal adaptive τ. */
  confidence: number;
  reason?: string;
}

export interface EscalationDecision {
  escalate: boolean;
  nextTier?: Tier;
  reason: string;
}

/**
 * Internal, adaptive escalation threshold τ (§6.5). It is calibrated from
 * usage_ledger / PLACEMENT data so the cheap tier absorbs everyday work and only the
 * genuinely hard tail escalates. It is deliberately NOT exposed in the public contract
 * (a raw float would leak an internal mechanism, be un-retunable as the pool swaps, and
 * be gameable). The constant below is the heuristic seed of that learned threshold; the
 * `max_tier` / `min_tier` semantic controls are what clients actually steer with.
 */
const TAU = 0.6;

const HEDGE_RE =
  /\b(i'?m not (entirely |really )?sure|i can'?t be certain|not confident|unclear|i don'?t know|cannot determine|might be wrong|hard to say)\b/i;

/**
 * Heuristic verifier self-confidence over a buffered (non-stream) answer.
 * NOT a learned head — it flags hedging language and pathologically short answers.
 * The provider's own confidence signal (when present) takes precedence.
 */
export function verify(text: string, providerConfidence?: number): VerifierResult {
  if (typeof providerConfidence === 'number') {
    return { confidence: providerConfidence, reason: 'provider_confidence' };
  }
  const trimmed = text.trim();
  if (HEDGE_RE.test(trimmed)) return { confidence: 0.4, reason: 'hedging_language' };
  if (trimmed.length < 8) return { confidence: 0.45, reason: 'answer_too_short' };
  return { confidence: 0.9, reason: 'confident' };
}

/**
 * Decide whether a buffered low/mid answer should be re-answered once at the next tier.
 * Bounded by `ceiling` (= min(max_tier, highest held scope)); never escalates past it.
 */
export function shouldEscalate(
  result: VerifierResult,
  currentTier: Tier,
  ceiling: Tier,
): EscalationDecision {
  if (result.confidence >= TAU) {
    return { escalate: false, reason: `confidence ${result.confidence.toFixed(2)} >= τ` };
  }
  if (tierRank(currentTier) >= tierRank(ceiling)) {
    return { escalate: false, reason: `at ceiling ${ceiling} — cannot escalate further` };
  }
  const next = nextTierUp(currentTier);
  if (!next) {
    return { escalate: false, reason: 'no higher tier' };
  }
  return {
    escalate: true,
    nextTier: next,
    reason: `confidence ${result.confidence.toFixed(2)} < τ → escalate ${currentTier}→${next}`,
  };
}
