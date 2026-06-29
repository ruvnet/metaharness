// Core request pipeline (ADR-203 §3.1 d–g, §3.3, §5.2). Shared by /v1/chat/completions
// and /v1/completions. Steps: route (tier pool + fallback chain) → infer → post-gen τ
// escalation (non-stream/auto only) → price at the RESOLVED tier. Auth + tier resolution
// happen in the route handler; this module owns infer/escalate/price.
import type { ChatCompletionRequest, EscalationStrategy, Tier, Usage } from '../types/openai';
import type { AppDeps } from '../deps';
import { type ModelProvider, type ProviderResult, ProviderError } from '../providers/types';
import type { TierResolution } from '../tier/resolveTier';
import { verify, shouldEscalate } from '../router/escalation';
import { priceUsd } from '../metering/pricing';

export interface InferOutcome {
  text: string;
  usage: Usage;
  resolvedTier: Tier;
  resolvedModel: string;
  escalated: boolean;
  capDegraded: boolean;
  routingReason: string;
  priceUsd: number;
}

/** Conservative local token floor (§5.1) — used only when the provider omits usage. */
function localUsage(req: ChatCompletionRequest, text: string): Usage {
  const approx = (s: string) => Math.max(1, Math.ceil(s.length / 4));
  const prompt = req.messages.reduce((n, m) => n + approx(m.content ?? ''), 0);
  const completion = approx(text);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function usageOf(req: ChatCompletionRequest, r: ProviderResult): Usage {
  return r.usage ?? localUsage(req, r.text);
}

/**
 * Try each model in a tier's ordered fallback chain (commit de512bd). A provider
 * 5xx/timeout fails over to the next model WITHIN the tier — never silently changing the
 * billed tier. Throws ProviderError only when the whole chain is exhausted.
 */
export async function inferWithFallback(
  provider: ModelProvider,
  models: string[],
  req: ChatCompletionRequest,
): Promise<ProviderResult & { model: string }> {
  const attempted: string[] = [];
  let lastErr: unknown;
  for (const model of models) {
    attempted.push(model);
    try {
      const r = await provider.complete(model, req);
      return { ...r, model };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new ProviderError(
    `all models failed in tier chain: ${attempted.join(', ')}${lastErr instanceof Error ? ` (last: ${lastErr.message})` : ''}`,
    attempted,
  );
}

/** Resolve the effective escalation strategy. `inflight` degrades to stream_oneshot today
 *  (the §3.5 midstream firewall: @midstream/wasm is absent → Option B). */
export function effectiveEscalation(req: ChatCompletionRequest): EscalationStrategy {
  const explicit = req.escalation;
  if (explicit) return explicit === 'inflight' ? 'stream_oneshot' : explicit;
  return req.stream ? 'stream_oneshot' : 'post_hoc';
}

/**
 * NON-STREAMING execution with post-gen τ escalation (§3.3, §6.5).
 * Escalation runs only for auto mode under post_hoc/buffered strategies; streams route
 * once up front (stream_oneshot) and never reach this re-answer path.
 */
export async function executeNonStream(
  deps: AppDeps,
  req: ChatCompletionRequest,
  resolution: TierResolution,
): Promise<InferOutcome> {
  const { config, provider } = deps;
  const strategy = effectiveEscalation(req);

  let tier = resolution.tier;
  let pool = config.tierPools[tier];
  let result = await inferWithFallback(provider, pool.models, req);
  let usage = usageOf(req, result);
  let escalated = false;
  let routingReason = resolution.routingReason;

  const escalationAllowed =
    resolution.mode === 'auto' && (strategy === 'post_hoc' || strategy === 'buffered');

  if (escalationAllowed) {
    const v = verify(result.text, result.confidence);
    const decision = shouldEscalate(v, tier, resolution.ceiling);
    if (decision.escalate && decision.nextTier) {
      tier = decision.nextTier;
      pool = config.tierPools[tier];
      result = await inferWithFallback(provider, pool.models, req);
      usage = usageOf(req, result);
      escalated = true;
      routingReason = `${routingReason}; ${decision.reason}`;
    }
  }

  return {
    text: result.text,
    usage,
    resolvedTier: tier,
    resolvedModel: result.model,
    escalated,
    capDegraded: resolution.capDegraded,
    routingReason,
    priceUsd: priceUsd(config, tier, usage),
  };
}
