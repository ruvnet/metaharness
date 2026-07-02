// OpenAI-compatible wire types (ADR-203 §3.4). Skeleton stubs — fields will be
// filled out during implementation. The shapes here are intentionally minimal
// but byte-compatible with the OpenAI chat/completions contract.

export type Tier = 'low' | 'mid' | 'high';

/** The four routing dials exposed via the `model` field (raw vendor ids rejected). */
export type CognitumModel =
  | 'cognitum-auto'
  | 'cognitum-low'
  | 'cognitum-mid'
  | 'cognitum-high'
  | 'cognitum-low-agent'
  | 'cognitum-mid-agent'
  | 'cognitum-high-agent'
  | 'cognitum-mock';

export type FallbackPolicy = 'fail_fast' | 'best_effort';

/** §3.4 / §3.5 escalation strategy. `inflight` is midstream-only and degrades to stream_oneshot. */
export type EscalationStrategy = 'stream_oneshot' | 'post_hoc' | 'buffered' | 'inflight';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  n?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  // Cognitum namespaced routing controls (also accepted as X-Cognitum-* headers).
  fallback_policy?: FallbackPolicy;
  min_tier?: Tier;
  max_tier?: Tier;
  escalation?: EscalationStrategy;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Namespaced response extension block (§3.4). */
export interface XCognitum {
  request_id: string;
  resolved_tier: Tier;
  resolved_model: string;
  escalated: boolean;
  cap_degraded: boolean;
  routing_reason?: string;
  price_usd: number;
}

export interface ChatCompletionChoice {
  index: number;
  message?: ChatMessage;
  delta?: Partial<ChatMessage>;
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion' | 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: Usage;
  x_cognitum?: XCognitum;
}

/** Uniform error envelope, matching the production gateway contract. */
export interface ErrorEnvelope {
  error: string;
  code: string;
  requestId: string;
}
