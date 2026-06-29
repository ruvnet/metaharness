// Canned mock provider (ADR-203 §7.3) — emulator-first $0 dev. Exercises the whole
// auth → tier → route → meter → bill loop offline with a DETERMINISTIC token stream:
// no network, no spend, repeatable. The mock also models the realistic escalation case
// — a cheap-tier model returning a hedged answer to a request that looked easy — so the
// §6.5 post-gen τ escalation path is testable without a real provider.
import type { ChatCompletionRequest } from '../types/openai';
import type { ModelProvider, ProviderDelta, ProviderResult } from './types';

/** Models in the low tier pool (config seed); the mock hedges here on sentinel prompts. */
const LOW_POOL = new Set(['deepseek-v4-pro', 'glm-5.2']);

function lastUserContent(req: ChatCompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i].role === 'user') return req.messages[i].content ?? '';
  }
  return req.messages[req.messages.length - 1]?.content ?? '';
}

/** ~chars/4 token estimate — the mock's synthetic count (real providers send authoritative usage). */
function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function promptTokens(req: ChatCompletionRequest): number {
  return req.messages.reduce((n, m) => n + approxTokens(m.content ?? ''), 0);
}

/**
 * Build the canned answer for (model, request). A low-pool model facing a prompt that
 * contains the `tricky` sentinel returns a deliberately hedged answer (low confidence →
 * τ fires → escalation); every other case returns a confident answer.
 */
function cannedAnswer(model: string, req: ChatCompletionRequest): { text: string; confidence: number } {
  const user = lastUserContent(req);
  const hedge = LOW_POOL.has(model) && /\btricky\b/i.test(user);
  if (hedge) {
    return {
      text: "I'm not entirely sure, but it might be one of a few possibilities.",
      confidence: 0.4,
    };
  }
  return {
    text: `mock(${model}): ${user.slice(0, 120)}`.trim(),
    confidence: 0.9,
  };
}

export class MockProvider implements ModelProvider {
  readonly name = 'mock';

  async complete(model: string, req: ChatCompletionRequest): Promise<ProviderResult> {
    const { text, confidence } = cannedAnswer(model, req);
    const prompt = promptTokens(req);
    const completion = approxTokens(text);
    return {
      text,
      confidence,
      usage: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
      },
    };
  }

  async *stream(model: string, req: ChatCompletionRequest): AsyncIterable<ProviderDelta> {
    const { text } = cannedAnswer(model, req);
    // Split into word-sized deltas so the SSE path is exercised like a real token stream.
    const parts = text.match(/\S+\s*/g) ?? [text];
    for (const part of parts) {
      yield { content: part, finishReason: null };
    }
    yield { content: '', finishReason: 'stop' };
  }
}
