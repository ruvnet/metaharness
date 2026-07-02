// Pricing computation (ADR-203 §5.2). Strictly linear pass on the RESOLVED tier —
// escalation low→high bills at high. Asymmetric in/out rates per tier. No vendor quirks.
//   Price_USD = in_tokens × Rate_In[resolved_tier] + out_tokens × Rate_Out[resolved_tier]
import type { Tier, Usage } from '../types/openai';
import type { Config } from '../config';

export function priceUsd(config: Config, resolvedTier: Tier, usage: Usage): number {
  const pool = config.tierPools[resolvedTier];
  return (
    (usage.prompt_tokens * pool.rateInPer1M) / 1_000_000 +
    (usage.completion_tokens * pool.rateOutPer1M) / 1_000_000
  );
}
