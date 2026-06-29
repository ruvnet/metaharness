// Progressive, FAMILY-CORRECT local token accounting (ADR-203 §5.1).
// Closes the truncation/disconnect billing hole: tokenize every outbound delta locally
// so a dropped TCP connection is still billed for what was generated.
// CRITICAL: never count non-OpenAI (deepseek/glm) output with an OpenAI tokenizer —
// 15–30% drift. Select the tokenizer (or byte→token ratio floor) by resolved_model family.
//
// This service ships the conservative, model-family-specific byte→token RATIO fallback
// (§5.1) rather than bundling multiple heavy WASM tokenizers into the Cloud Run image.
// Per-family ratios — never one global constant — keep the cheap tier from being mis-billed
// with an OpenAI profile. In all cases the provider's authoritative final count is preferred
// when it arrives; this local estimate is only the FLOOR / disconnect-fallback.
import type { Tier } from '../types/openai';

export type ModelFamily = 'openai' | 'deepseek' | 'glm' | 'gemini' | 'anthropic' | 'unknown';

/**
 * UTF-8 bytes per token, per family. Distinct per family by design: deepseek-v4 / glm-5.2
 * use larger-vocabulary BPE schemes than OpenAI's cl100k/o200k, so their average token
 * packs more bytes — counting their output with the OpenAI ratio would over-count ~15–30%
 * (§5.1). `unknown` falls back to the conservative OpenAI-ish ratio.
 */
const BYTES_PER_TOKEN: Record<ModelFamily, number> = {
  openai: 4.0,
  deepseek: 4.7,
  glm: 4.7,
  gemini: 4.2,
  anthropic: 3.8,
  unknown: 4.0,
};

/** Resolve the BPE family of the model that actually served the request (§5.1). */
export function familyOf(resolvedModel: string): ModelFamily {
  const m = resolvedModel.toLowerCase();
  if (/deepseek/.test(m)) return 'deepseek';
  if (/\bglm\b|^glm[-\d]|zhipu|chatglm/.test(m)) return 'glm';
  if (/gpt|^o[134]\b|openai|davinci|text-embedding/.test(m)) return 'openai';
  if (/gemini|palm|bison/.test(m)) return 'gemini';
  if (/claude|anthropic/.test(m)) return 'anthropic';
  return 'unknown';
}

/** UTF-8 byte length (the local floor counts BYTES, not JS UTF-16 chars, per §5.1). */
function byteLen(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Estimate tokens for a given family over a complete string (the byte→token floor). */
export function estimateTokensForFamily(family: ModelFamily, text: string): number {
  const bytes = byteLen(text);
  if (bytes === 0) return 0;
  return Math.max(1, Math.ceil(bytes / BYTES_PER_TOKEN[family]));
}

/** Family-correct token estimate for the model that served the request (§5.1 floor). */
export function estimateTokens(resolvedModel: string, text: string): number {
  return estimateTokensForFamily(familyOf(resolvedModel), text);
}

/** A running, incremental token counter fed each outbound delta chunk. */
export interface ProgressiveCounter {
  readonly tier: Tier;
  readonly family: ModelFamily;
  pushDelta(text: string): void;
  /** Local floor estimate — used on disconnect; provider's final count preferred when it arrives. */
  completionTokens(): number;
}

/**
 * Build a family-correct progressive counter. Accumulates BYTES across deltas and divides
 * by the resolved family's byte→token ratio (the conservative §5.1 fallback). Dividing the
 * accumulated byte total once (rather than summing per-delta ceilings) avoids per-chunk
 * rounding inflation — the floor stays tight to the true token count.
 */
export function makeCounter(resolvedModel: string, tier: Tier): ProgressiveCounter {
  const family = familyOf(resolvedModel);
  const ratio = BYTES_PER_TOKEN[family];
  let bytes = 0;
  return {
    tier,
    family,
    pushDelta(text: string): void {
      bytes += byteLen(text);
    },
    completionTokens(): number {
      return bytes === 0 ? 0 : Math.max(1, Math.ceil(bytes / ratio));
    },
  };
}
