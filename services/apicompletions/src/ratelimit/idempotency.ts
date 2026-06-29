// Idempotency (ADR-203 §5.3). Optional Idempotency-Key header → idempotency/{key} doc
// caching the response + status for 24h. Replays return the stored result and are NOT
// re-billed. Critical for streaming retries.
import type { ChatCompletionResponse } from '../types/openai';

export interface CachedResponse {
  status: number;
  body: ChatCompletionResponse;
}

/** TODO(impl): lookup idempotency/{key}. */
export async function lookup(_key: string): Promise<CachedResponse | null> {
  throw new Error('not implemented: idempotency.lookup (ADR-203 §5.3)');
}

/** TODO(impl): store with a 24h TTL. */
export async function store(_key: string, _resp: CachedResponse): Promise<void> {
  throw new Error('not implemented: idempotency.store (ADR-203 §5.3)');
}
