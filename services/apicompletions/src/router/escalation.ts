// Confidence-driven escalation (ADR-203 §3.3, §6.5) — NON-STREAMING (post_hoc) only.
// τ is internal + adaptive, MetaHarness-owned, never a public input. Streams route once
// up front (stream_oneshot) on the input signal; they do NOT run post-gen escalation.
import type { Tier } from '../types/openai';

export interface VerifierResult {
  /** Internal self-confidence in [0,1]; compared against the internal adaptive τ. */
  confidence: number;
}

export interface EscalationDecision {
  escalate: boolean;
  nextTier?: Tier;
  reason: string;
}

/**
 * Decide whether a buffered low/mid answer should be re-answered once at the next tier.
 * Capped by the key's scopes and the request's max_tier. TODO(impl).
 */
export function shouldEscalate(
  _result: VerifierResult,
  _currentTier: Tier,
  _maxTier: Tier,
): EscalationDecision {
  throw new Error('not implemented: shouldEscalate (ADR-203 §6.5)');
}
