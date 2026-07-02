// Anthropic Messages API wire types (/v1/messages). The subset Cognitum Fugu accepts +
// emits — text content only (tool_use / images are accepted-and-ignored at the canonical
// boundary in v1). Mirrors the public Anthropic Messages contract closely enough that an
// off-the-shelf Anthropic SDK can target this endpoint, while the response model field always
// carries the REAL resolved model (the honesty guard — never misrepresented as Claude).
import type { XCognitum } from '../types/openai';

/** An Anthropic text content block. */
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

/** Anthropic content is a bare string OR an array of typed blocks (we extract text blocks). */
export type AnthropicContent = string | Array<{ type: string; text?: string; [k: string]: unknown }>;

export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: AnthropicContent;
}

/** POST /v1/messages request body. `max_tokens` is REQUIRED by the Anthropic contract. */
export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessageParam[];
  system?: AnthropicContent;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  metadata?: unknown;
  tools?: unknown[];
  tool_choice?: unknown;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

/** Non-streaming /v1/messages response. */
export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicTextBlock[];
  /** HONESTY GUARD — the REAL resolved model that served, never the requested Claude alias. */
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
  /** Cognitum routing transparency (resolved_model / resolved_tier surfaced honestly). */
  x_cognitum?: XCognitum;
}
