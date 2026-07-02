// Intrinsic difficulty signal (ADR-203 §3.3, PLACEMENT §7). Heuristic, NOT a trained
// head — prompt length, code/diff presence, reasoning markers, max_tokens, tool use.
// Applied at REQUEST granularity to pick the starting (and, for streams, the only) tier.
// The signal is INTRINSIC to the request (no oracle, §8 conformance firewall).
import type { ChatCompletionRequest, Tier } from '../types/openai';

export interface DifficultySignal {
  tier: Tier;
  score: number;
  reason: string;
}

const CODE_MARKERS = /```|diff --git|^[+-]{3}\s|\bfunction\b|\bclass\b|\bimport\b|\bSELECT\b|=>/m;
const REASONING_MARKERS =
  /\b(prove|derive|explain why|step[- ]by[- ]step|reason through|analy[sz]e|design|architect|algorithm|complexity|refactor|debug|optimi[sz]e|trade-?off)\b/i;

function totalChars(req: ChatCompletionRequest): number {
  return req.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
}

/**
 * Compute the intrinsic signal from the request alone. Additive scoring → tier:
 *   score >= 4 → high · score >= 2 → mid · else low.
 */
export function computeDifficulty(req: ChatCompletionRequest): DifficultySignal {
  const chars = totalChars(req);
  const joined = req.messages.map((m) => m.content ?? '').join('\n');
  const fired: string[] = [];
  let score = 0;

  if (chars > 4000) {
    score += 2;
    fired.push('long_prompt');
  } else if (chars > 1200) {
    score += 1;
    fired.push('medium_prompt');
  }

  if (CODE_MARKERS.test(joined)) {
    score += 2;
    fired.push('code/diff');
  }

  if (REASONING_MARKERS.test(joined)) {
    score += 1;
    fired.push('reasoning_markers');
  }

  const maxTokens = req.max_tokens ?? 0;
  if (maxTokens > 4000) {
    score += 2;
    fired.push('large_max_tokens');
  } else if (maxTokens > 1500) {
    score += 1;
    fired.push('moderate_max_tokens');
  }

  if (Array.isArray(req.tools) && req.tools.length > 0) {
    score += 1;
    fired.push('tool_use');
  }

  const tier: Tier = score >= 4 ? 'high' : score >= 2 ? 'mid' : 'low';
  const reason =
    fired.length > 0
      ? `difficulty=${tier} (score=${score}: ${fired.join(',')})`
      : `difficulty=${tier} (score=0: everyday)`;
  return { tier, score, reason };
}
