// Model provider abstraction (ADR-203 §3.2, §3.5). A provider serves one resolved model;
// the per-tier fallback chain (commit de512bd) fails over WITHIN a tier on 5xx/timeout
// without silently changing the billed tier.
import type { ChatCompletionRequest, Usage } from '../types/openai';

export interface ProviderDelta {
  content: string;
  finishReason?: string | null;
}

export interface ProviderResult {
  text: string;
  usage?: Usage; // provider's authoritative count when present (§5.1)
}

export interface ModelProvider {
  readonly name: string;
  /** Non-streaming completion. */
  complete(model: string, req: ChatCompletionRequest): Promise<ProviderResult>;
  /** Streaming completion — async iterator of deltas (mapped to OpenAI SSE upstream). */
  stream(model: string, req: ChatCompletionRequest): AsyncIterable<ProviderDelta>;
}
