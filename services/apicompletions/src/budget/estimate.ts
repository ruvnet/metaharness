// Worst-case reservation estimate (ADR-204 rev-2 §5.2). The RESERVE step reserves the
// WORST-CASE cost block at the CEILING tier (the highest tier escalation can reach) so a
// request is never admitted that we could not afford at its worst case:
//
//   estimateUsd = promptTokens · Rate_In[ceilingTier] + maxTokens · Rate_Out[ceilingTier]
//
// The prompt is known up front; maxTokens is the worst-case output. Over-reservation is
// RELEASED at COMMIT (the estimate − actual gap returns to headroom), so it only transiently
// reduces available budget — the conservative direction.
import type { ChatMessage, Tier } from '../types/openai';
import type { Config } from '../config';
import { estimateTokens } from '../metering/tokenizer';

/** Family-correct prompt-token floor for the model that would serve at the ceiling tier. */
export function promptTokenFloor(config: Config, ceilingTier: Tier, messages: ChatMessage[]): number {
  const model = config.tierPools[ceilingTier].models[0];
  return messages.reduce((n, m) => n + estimateTokens(model, m.content ?? ''), 0);
}

/** Worst-case estimate at the ceiling tier — never under-reserves (§5.2). */
export function worstCaseEstimateUsd(
  config: Config,
  ceilingTier: Tier,
  promptTokens: number,
  maxOutputTokens: number,
): number {
  const pool = config.tierPools[ceilingTier];
  return (
    (promptTokens * pool.rateInPer1M) / 1_000_000 +
    (maxOutputTokens * pool.rateOutPer1M) / 1_000_000
  );
}

/** Resolve the worst-case output bound: the request's max_tokens, else the config ceiling. */
export function maxOutputTokens(config: Config, requested: number | undefined): number {
  return requested && requested > 0 ? requested : config.budget.defaultMaxOutputTokens;
}
