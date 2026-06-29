// Tier resolution + scope enforcement (ADR-203 §3.3, §6 item 2).
import type { CognitumModel, FallbackPolicy, Tier } from '../types/openai';
import type { ApiKeyDoc } from '../auth/apiKey';

export interface TierResolution {
  /** Tier that will execute (the billed tier). */
  tier: Tier;
  /** Auto mode resolves via the difficulty signal; explicit modes pin the tier. */
  mode: 'auto' | 'explicit';
  agentic: boolean;
  capDegraded: boolean;
  routingReason?: string;
}

/** Map the cognitum-* model alias to {mode, baseTier, agentic}. Raw vendor ids -> null (404). */
export function parseModelAlias(
  _model: string,
): { mode: 'auto' | 'explicit'; tier?: Tier; agentic: boolean } | null {
  throw new Error('not implemented: parseModelAlias (ADR-203 §3.4)');
}

/**
 * Enforce scope ↔ tier (§6 item 2). On scope mismatch in auto mode, behaviour is
 * governed by fallback_policy: fail_fast (403) | best_effort (cap + cap_degraded).
 * TODO(impl).
 */
export function enforceScope(
  _key: ApiKeyDoc,
  _wanted: Tier,
  _model: CognitumModel,
  _policy: FallbackPolicy,
): TierResolution {
  throw new Error('not implemented: enforceScope (ADR-203 §6 item 2)');
}
