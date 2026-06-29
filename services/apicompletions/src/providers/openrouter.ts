// OpenRouter / direct provider (ADR-203 §3.1 step e). Key bound via Secret Manager
// (OPENROUTER_API_KEY, §7.1), never forwarded to clients, never logged. Only a
// deliberate, budgeted smoke test ever hits a real provider — tests use the MockProvider.
//
// Uses Node 20's built-in global fetch (no node-fetch import needed; sidesteps the
// ESM/CommonJS interop with node-fetch v3 under tsc module=commonjs).
import type { ChatCompletionRequest } from '../types/openai';
import { type ModelProvider, type ProviderDelta, type ProviderResult, ProviderError } from './types';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterChoice {
  message?: { content?: string };
  text?: string;
}
interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class OpenRouterProvider implements ModelProvider {
  readonly name = 'openrouter';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = OPENROUTER_URL,
  ) {}

  async complete(model: string, req: ChatCompletionRequest): Promise<ProviderResult> {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: req.messages,
        temperature: req.temperature,
        top_p: req.top_p,
        max_tokens: req.max_tokens,
        stop: req.stop,
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new ProviderError(`openrouter ${model} → HTTP ${res.status}`, [model]);
    }
    const data = (await res.json()) as OpenRouterResponse;
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? choice?.text ?? '';
    const usage = data.usage
      ? {
          prompt_tokens: data.usage.prompt_tokens ?? 0,
          completion_tokens: data.usage.completion_tokens ?? 0,
          total_tokens:
            data.usage.total_tokens ??
            (data.usage.prompt_tokens ?? 0) + (data.usage.completion_tokens ?? 0),
        }
      : undefined;
    return { text, usage };
  }

  // True token-level streaming is deferred to the streaming phase (§3.3 stream_oneshot).
  // For now the streaming surface is served by buffering complete() and emitting it as a
  // single delta, so the SSE contract holds even against a real provider without a
  // bespoke SSE parser. The mock provider yields real word-sized deltas for tests.
  async *stream(model: string, req: ChatCompletionRequest): AsyncIterable<ProviderDelta> {
    const result = await this.complete(model, req);
    yield { content: result.text, finishReason: null };
    yield { content: '', finishReason: 'stop' };
  }
}
