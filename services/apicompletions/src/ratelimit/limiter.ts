// Rate limit / quota — scatter-gather, append-only (ADR-203 §5.3).
// NOT a single-doc transactional counter (would hit Firestore's ~1 write/sec/doc wall).
// Each request writes an ephemeral TTL'd tick api_keys/{keyHash}/usage_ticks/{tickId};
// the check is a COUNT() aggregation over the window. GLOBAL (fixes sec-review §1
// per-instance Map bug) without a hot-spot.
// Cost guards (§5.3): instance-local ≈500ms–1s debounce on the per-key COUNT +
// 1-minute bucketed ticks. Memorystore is the at-scale option (not the serverless default).
import type { Tier } from '../types/openai';

export interface RateDecision {
  allowed: boolean;
  /** When false, the 429 retry hint. */
  retryAfterMs?: number;
}

/** TODO(impl): append a TTL'd tick, then COUNT() the window (debounced). */
export async function checkAndRecord(
  _keyHash: string,
  _tier: Tier,
  _limitPerMin: number,
): Promise<RateDecision> {
  throw new Error('not implemented: checkAndRecord (ADR-203 §5.3)');
}
