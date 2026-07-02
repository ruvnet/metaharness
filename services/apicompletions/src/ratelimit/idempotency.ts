// Idempotency (ADR-203 §5.3). Optional Idempotency-Key header → idempotency/{key} doc
// caching the response + status for 24h. Replays return the stored result and are NOT
// re-billed (the route short-circuits before rate-limit + metering). Critical for
// streaming retries. DI'd behind a store interface like the rest of the metering surface.
import type { FirestoreLike } from '../firestore/client';

/**
 * Cached body — a serialized JSON response object. Broadened from the OpenAI response shape to
 * a generic JSON record so the SAME cache serves both /v1/chat/completions (ChatCompletionResponse)
 * and /v1/messages (AnthropicMessageResponse); the value is only ever re-serialized, never read
 * field-by-field, so the concrete shape does not matter here.
 */
export type CachedBody = object;

export interface CachedResponse {
  status: number;
  body: CachedBody;
}

/** 24h cache window (§5.3). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyStore {
  lookup(key: string): Promise<CachedResponse | null>;
  store(key: string, resp: CachedResponse): Promise<void>;
}

interface Entry {
  resp: CachedResponse;
  expireAt: number;
}

/** $0 emulator-first / test idempotency store with a 24h TTL. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly byKey = new Map<string, Entry>();

  async lookup(key: string): Promise<CachedResponse | null> {
    const e = this.byKey.get(key);
    if (!e) return null;
    if (e.expireAt <= Date.now()) {
      this.byKey.delete(key);
      return null;
    }
    // Return a deep-ish clone so callers can't mutate the cached row.
    return { status: e.resp.status, body: { ...e.resp.body } };
  }

  async store(key: string, resp: CachedResponse): Promise<void> {
    this.byKey.set(key, {
      resp: { status: resp.status, body: { ...resp.body } },
      expireAt: Date.now() + IDEMPOTENCY_TTL_MS,
    });
  }
}

/**
 * Production idempotency — idempotency/{key} via firebase-admin (structurally typed,
 * SDK deferred). `expireAt` carries the Firestore TTL-policy field for the 24h reap.
 */
export class FirestoreIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: FirestoreLike) {}

  async lookup(key: string): Promise<CachedResponse | null> {
    const snap = await this.db.collection('idempotency').doc(key).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!data) return null;
    if (typeof data.expireAt === 'number' && data.expireAt <= Date.now()) return null;
    return { status: data.status as number, body: data.body as CachedBody };
  }

  async store(key: string, resp: CachedResponse): Promise<void> {
    await this.db
      .collection('idempotency')
      .doc(key)
      .set({ status: resp.status, body: resp.body, expireAt: Date.now() + IDEMPOTENCY_TTL_MS });
  }
}
