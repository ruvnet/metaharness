// Canned mock provider (ADR-203 §7.3) — emulator-first $0 dev. Exercises the whole
// auth → tier → route → meter → bill loop offline with a deterministic token stream.
import type { ChatCompletionRequest } from '../types/openai';
import type { ModelProvider, ProviderDelta, ProviderResult } from './types';

export class MockProvider implements ModelProvider {
  readonly name = 'mock';

  async complete(_model: string, _req: ChatCompletionRequest): Promise<ProviderResult> {
    // TODO(impl): return a canned answer + synthetic usage.
    throw new Error('not implemented: MockProvider.complete (ADR-203 §7.3)');
  }

  async *stream(_model: string, _req: ChatCompletionRequest): AsyncIterable<ProviderDelta> {
    // TODO(impl): yield canned deltas, then a terminal chunk.
    throw new Error('not implemented: MockProvider.stream (ADR-203 §7.3)');
  }
}
