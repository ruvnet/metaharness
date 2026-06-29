// Anthropic ↔ canonical translation adapter (/v1/messages). Pure functions, unit-testable:
//   anthropicToCanonical : Anthropic request → the canonical ChatCompletionRequest the
//                          existing tier/route/meter pipeline already understands.
//   mapModelToDial       : opus*→cognitum-high, sonnet*→cognitum-mid, haiku*→cognitum-low,
//                          cognitum-* dials pass through, anything else → cognitum-auto. The
//                          min/max_tier + fail_fast/best_effort controls (X-Cognitum-* headers
//                          merged onto the canonical body) are honored by resolveTier as usual.
//   buildAnthropicResponse : canonical outcome → the Anthropic message shape, with the REAL
//                          resolved model in the `model` field (the honesty guard).
import type { ChatCompletionRequest, ChatMessage, Usage, XCognitum } from '../types/openai';
import type {
  AnthropicContent,
  AnthropicMessageResponse,
  AnthropicMessagesRequest,
} from './types';

/** Flatten Anthropic content (string or block array) to plain text — text blocks only. */
export function extractText(content: AnthropicContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/**
 * Map an Anthropic (or cognitum-*) model id to the Cognitum routing dial. The Claude family
 * names map to tiers by capability (opus→high, sonnet→mid, haiku→low); a cognitum-* dial is
 * passed through verbatim (so a client can opt into cognitum-auto/low/mid/high explicitly);
 * an unrecognized id falls back to cognitum-auto (difficulty routing + the honesty guard).
 */
export function mapModelToDial(model: string): string {
  const m = model.toLowerCase();
  if (/^cognitum-/.test(m)) return model; // explicit cognitum dial — pass through
  if (/opus/.test(m)) return 'cognitum-high';
  if (/sonnet/.test(m)) return 'cognitum-mid';
  if (/haiku/.test(m)) return 'cognitum-low';
  return 'cognitum-auto';
}

/** Anthropic Messages request → the canonical ChatCompletionRequest. */
export function anthropicToCanonical(req: AnthropicMessagesRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];
  if (req.system !== undefined) {
    const sys = extractText(req.system);
    if (sys.length > 0) messages.push({ role: 'system', content: sys });
  }
  for (const m of req.messages) {
    messages.push({ role: m.role, content: extractText(m.content) });
  }
  return {
    model: mapModelToDial(req.model),
    messages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stream: req.stream,
    stop: req.stop_sequences,
  };
}

/**
 * Map an OpenAI-style finish_reason to an Anthropic stop_reason. `length`→`max_tokens`,
 * everything that is a clean stop (including `content_filter`, `stop`, or an absent reason)
 * → `end_turn`. `stop_sequence` is reserved for a future stop-sequence match.
 */
export function mapStopReason(finish: string | null | undefined): string {
  if (finish === 'length') return 'max_tokens';
  return 'end_turn';
}

/** Build the non-streaming Anthropic message response (model = REAL resolved model). */
export function buildAnthropicResponse(args: {
  requestId: string;
  resolvedModel: string;
  text: string;
  usage: Usage;
  stopReason: string;
  xCognitum: XCognitum;
}): AnthropicMessageResponse {
  return {
    id: `msg_${args.requestId}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: args.text }],
    model: args.resolvedModel, // HONESTY GUARD — surface the real model, never the Claude alias
    stop_reason: args.stopReason,
    stop_sequence: null,
    usage: { input_tokens: args.usage.prompt_tokens, output_tokens: args.usage.completion_tokens },
    x_cognitum: args.xCognitum,
  };
}
