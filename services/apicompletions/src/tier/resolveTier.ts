// Tier resolution + scope enforcement (ADR-203 §3.3, §3.4, §6 item 2).
// The `model` field is the routing dial; raw vendor ids are rejected (404). Auto mode
// maps the intrinsic difficulty signal → starting tier, bounded by min_tier/max_tier and
// capped by the key's held scopes; scope mismatch is governed by fallback_policy.
import type { ChatCompletionRequest, CognitumModel, FallbackPolicy, Tier } from '../types/openai';
import { type ApiKeyDoc, highestHeldTier, holdsTier } from '../auth/apiKey';
import { computeDifficulty, type DifficultySignal } from '../router/difficulty';

const TIER_ORDER: Tier[] = ['low', 'mid', 'high'];
export function tierRank(t: Tier): number {
  return TIER_ORDER.indexOf(t);
}
function maxTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}
function minTier(a: Tier, b: Tier): Tier {
  return tierRank(a) <= tierRank(b) ? a : b;
}
/** Next tier up, or null at the ceiling. */
export function nextTierUp(t: Tier): Tier | null {
  const i = tierRank(t);
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null;
}

export interface TierResolution {
  kind: 'ok';
  /** Tier that will execute (the billed/starting tier). */
  tier: Tier;
  /** Auto mode resolves via the difficulty signal; explicit modes pin the tier. */
  mode: 'auto' | 'explicit';
  agentic: boolean;
  capDegraded: boolean;
  routingReason: string;
  /** Quality floor (min_tier) honoured during routing. */
  floor: Tier;
  /** Escalation cost cap — min(max_tier ?? high, highest held tier). Bounds τ (§6.5). */
  ceiling: Tier;
  difficulty?: DifficultySignal;
}

export interface TierError {
  kind: 'error';
  status: number;
  code: string;
  error: string;
}

const ALIAS_RE = /^cognitum-(auto|low|mid|high|mock)(-agent)?$/;

/** Map a cognitum-* alias to {mode, tier?, agentic}. Raw vendor ids → null (→ 404). */
export function parseModelAlias(
  model: string,
): { mode: 'auto' | 'explicit'; tier?: Tier; agentic: boolean } | null {
  const m = ALIAS_RE.exec(model);
  if (!m) return null;
  const which = m[1];
  const agentic = m[2] === '-agent';
  if (which === 'auto') return { mode: 'auto', agentic };
  // cognitum-mock is the non-prod $0 alias (§7.3); it pins the low tier against the mock provider.
  if (which === 'mock') return { mode: 'explicit', tier: 'low', agentic };
  return { mode: 'explicit', tier: which as Tier, agentic };
}

/**
 * Resolve the request's model dial + difficulty + key scopes into the tier that will run.
 * Returns a {kind:'ok'} resolution or a {kind:'error'} wire error (404 model / 403 scope).
 */
export function resolveTier(req: ChatCompletionRequest, key: ApiKeyDoc): TierResolution | TierError {
  const parsed = parseModelAlias(req.model);
  if (!parsed) {
    return {
      kind: 'error',
      status: 404,
      code: 'model_not_found',
      error: `Unknown model '${req.model}'. Use a cognitum-* tier alias (cognitum-auto|low|mid|high); raw vendor ids are not accepted.`,
    };
  }

  // Explicit mode pins the tier — no routing, no escalation. Key must hold the scope.
  if (parsed.mode === 'explicit') {
    const tier = parsed.tier!;
    if (!holdsTier(key, tier)) {
      return {
        kind: 'error',
        status: 403,
        code: 'tier_scope_insufficient',
        error: `Model '${req.model}' requires the completions:${tier} scope, which this API key does not hold.`,
      };
    }
    return {
      kind: 'ok',
      tier,
      mode: 'explicit',
      agentic: parsed.agentic,
      capDegraded: false,
      routingReason: `explicit:${tier}`,
      floor: tier,
      ceiling: tier,
    };
  }

  // Auto mode — needs at least one completions scope.
  const held = highestHeldTier(key);
  if (!held) {
    return {
      kind: 'error',
      status: 403,
      code: 'no_completions_scope',
      error: 'API key holds no completions:{low,mid,high} scope.',
    };
  }

  const diff = computeDifficulty(req);
  // Clamp the difficulty-implied tier by the request's quality floor / cost cap.
  let wanted = diff.tier;
  const floor = req.min_tier ?? 'low';
  const reqCap = req.max_tier ?? 'high';
  wanted = maxTier(wanted, floor); // never below the quality floor
  wanted = minTier(wanted, reqCap); // never above the cost cap

  // Escalation ceiling: bounded by both the cost cap and the highest held scope (§6.5).
  const ceiling = minTier(reqCap, held);

  if (tierRank(wanted) > tierRank(held)) {
    // Scope mismatch — difficulty needs a tier the key lacks (§6 item 2).
    const policy: FallbackPolicy = req.fallback_policy ?? 'fail_fast';
    if (policy === 'fail_fast') {
      return {
        kind: 'error',
        status: 403,
        code: 'tier_scope_insufficient',
        error: `Task difficulty requires cognitum-${wanted} tier, but this API key is limited to completions:${held}.`,
      };
    }
    // best_effort — run at the highest held tier and flag cap_degraded.
    return {
      kind: 'ok',
      tier: held,
      mode: 'auto',
      agentic: parsed.agentic,
      capDegraded: true,
      routingReason: `best_effort: ${diff.reason} capped to held ${held}`,
      floor,
      ceiling,
      difficulty: diff,
    };
  }

  return {
    kind: 'ok',
    tier: wanted,
    mode: 'auto',
    agentic: parsed.agentic,
    capDegraded: false,
    routingReason: wanted === diff.tier ? diff.reason : `${diff.reason} clamped to ${wanted} (min=${floor},max=${reqCap})`,
    floor,
    ceiling,
    difficulty: diff,
  };
}

/** Re-export for callers that only need to know about the model alias / cognitum dial. */
export type { CognitumModel };
