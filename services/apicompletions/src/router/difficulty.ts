// Intrinsic difficulty signal (ADR-203 §3.3, PLACEMENT §7). Heuristic, NOT a trained
// head — prompt length, code/diff presence, reasoning markers, max_tokens, tool use.
// Applied at REQUEST granularity to pick the starting (and, for streams, the only) tier.
import type { ChatCompletionRequest, Tier } from '../types/openai';

export interface DifficultySignal {
  tier: Tier;
  score: number;
  reason: string;
}

/** TODO(impl): compute intrinsic signal from the request alone (no oracle, §8 firewall). */
export function computeDifficulty(_req: ChatCompletionRequest): DifficultySignal {
  throw new Error('not implemented: computeDifficulty (ADR-203 §3.3)');
}
