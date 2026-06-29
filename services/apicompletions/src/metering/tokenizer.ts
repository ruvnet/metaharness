// Progressive, FAMILY-CORRECT local token accounting (ADR-203 §5.1).
// Closes the truncation/disconnect billing hole: tokenize every outbound delta locally
// so a dropped TCP connection is still billed for what was generated.
// CRITICAL: never count non-OpenAI (deepseek/glm) output with an OpenAI tokenizer —
// 15–30% drift. Select the tokenizer (or byte→token ratio floor) by resolved_model family.
import type { Tier } from '../types/openai';

export type ModelFamily = 'openai' | 'deepseek' | 'glm' | 'gemini' | 'anthropic' | 'unknown';

/** Resolve the BPE family of the model that actually served the request. TODO(impl). */
export function familyOf(_resolvedModel: string): ModelFamily {
  throw new Error('not implemented: familyOf (ADR-203 §5.1)');
}

/** A running, incremental token counter fed each outbound delta chunk. */
export interface ProgressiveCounter {
  readonly tier: Tier;
  pushDelta(text: string): void;
  /** Local floor estimate — used on disconnect; provider's final count preferred when it arrives. */
  completionTokens(): number;
}

/**
 * Build a family-correct progressive counter. Falls back to a conservative,
 * per-family byte→token ratio when a WASM tokenizer bundle is too heavy (§5.1). TODO(impl).
 */
export function makeCounter(_resolvedModel: string, _tier: Tier): ProgressiveCounter {
  throw new Error('not implemented: makeCounter (ADR-203 §5.1)');
}
