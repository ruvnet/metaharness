// OpenRouter / direct provider (ADR-203 §3.1 step e). Key bound via Secret Manager
// (OPENROUTER_API_KEY, §7.1), never forwarded to clients, never logged. Only a
// deliberate, budgeted smoke test ever hits a real provider.
import type { ChatCompletionRequest } from '../types/openai';
import type { ModelProvider, ProviderDelta, ProviderResult } from './types';

export class OpenRouterProvider implements ModelProvider {
  readonly name = 'openrouter';

  constructor(private readonly apiKey: string) {}

  async complete(_model: string, _req: ChatCompletionRequest): Promise<ProviderResult> {
    throw new Error('not implemented: OpenRouterProvider.complete (ADR-203 §3.1e)');
  }

  async *stream(_model: string, _req: ChatCompletionRequest): AsyncIterable<ProviderDelta> {
    throw new Error('not implemented: OpenRouterProvider.stream (ADR-203 §3.1e)');
  }
}
