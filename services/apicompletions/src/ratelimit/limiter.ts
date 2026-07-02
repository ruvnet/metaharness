// Rate limit / quota — scatter-gather, append-only (ADR-203 §5.3).
// NOT a single-doc transactional counter (would hit Firestore's ~1 write/sec/doc wall).
// Each request writes an ephemeral TTL'd tick api_keys/{keyHash}/usage_ticks/{tickId};
// the check is a COUNT() aggregation over the window. GLOBAL (fixes sec-review §1
// per-instance Map bug) without a hot-spot.
// Cost guards (§5.3): instance-local ≈500ms–1s debounce on the per-key COUNT +
// 1-minute bucketed ticks. Memorystore is the at-scale option (not the serverless default).
import { randomBytes } from 'crypto';
import type { Tier } from '../types/openai';
import type { FirestoreLike } from '../firestore/client';

export interface RateDecision {
  allowed: boolean;
  /** Observed window count at decision time (post-debounce). */
  count: number;
  /** When false, the 429 retry hint (ms). */
  retryAfterMs?: number;
}

/** One append-only tick. `bucketMinute` groups ticks into 1-minute docs (§5.3 bucketing). */
export interface UsageTick {
  tier: Tier;
  ts: number;
  bucketMinute: number;
  /** Absolute epoch-ms at which Firestore's TTL policy reaps the tick. */
  expireAt: number;
}

/**
 * The tick store: append-only writes + a COUNT() window scan. Production binds Firestore
 * subcollections + an aggregation query; tests/emulators use the in-memory fake. The
 * window is GLOBAL across instances (the §5.3 fix for the per-instance `Map` bug).
 */
export interface RateLimitStore {
  appendTick(keyHash: string, tick: UsageTick): Promise<void>;
  /** COUNT() of this key's ticks for `tier` with `ts >= sinceMs`. */
  countWindow(keyHash: string, tier: Tier, sinceMs: number): Promise<number>;
}

const MINUTE_MS = 60_000;
function tickId(bucketMinute: number): string {
  return `${bucketMinute}-${randomBytes(8).toString('hex')}`;
}

/** $0 emulator-first / test tick store. Reaps expired ticks lazily on each count. */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly byKey = new Map<string, UsageTick[]>();

  async appendTick(keyHash: string, tick: UsageTick): Promise<void> {
    const arr = this.byKey.get(keyHash) ?? [];
    arr.push(tick);
    this.byKey.set(keyHash, arr);
  }

  async countWindow(keyHash: string, tier: Tier, sinceMs: number): Promise<number> {
    const now = Date.now();
    const arr = this.byKey.get(keyHash);
    if (!arr) return 0;
    // Reap TTL-expired ticks (mirrors Firestore's TTL policy auto-reap).
    const live = arr.filter((t) => t.expireAt > now);
    if (live.length !== arr.length) this.byKey.set(keyHash, live);
    return live.reduce((n, t) => (t.tier === tier && t.ts >= sinceMs ? n + 1 : n), 0);
  }
}

/**
 * Production tick store — append-only subcollection creates + a Firestore COUNT()
 * aggregation over the window. Subcollection creates avoid the single-doc transactional
 * counter hot-spot (§5.3); `expireAt` carries the Firestore TTL-policy field.
 */
export class FirestoreRateLimitStore implements RateLimitStore {
  constructor(private readonly db: FirestoreLike) {}

  async appendTick(keyHash: string, tick: UsageTick): Promise<void> {
    await this.db
      .collection('api_keys')
      .doc(keyHash)
      .collection('usage_ticks')
      .doc(tickId(tick.bucketMinute))
      .set({ ...tick });
  }

  async countWindow(keyHash: string, tier: Tier, sinceMs: number): Promise<number> {
    const snap = await this.db
      .collection('api_keys')
      .doc(keyHash)
      .collection('usage_ticks')
      .where('tier', '==', tier)
      .where('ts', '>=', sinceMs)
      .count()
      .get();
    return snap.data().count;
  }
}

export interface RateLimiterOptions {
  /** Sliding window (default 60s — per-minute limits, §4.2). */
  windowMs?: number;
  /** Instance-local COUNT() debounce TTL (≈500ms–1s, §5.3). Soft over-admit within it. */
  debounceMs?: number;
}

interface CacheEntry {
  count: number;
  fetchedAt: number;
}

/**
 * Scatter-gather rate limiter (§5.3). Per (keyHash, tier): append a TTL'd tick, COUNT() the
 * window, compare to the per-tier limit. A short instance-local debounce cache bounds
 * aggregation reads to ~1–2/sec/instance/key regardless of request rate. The debounce makes
 * the limiter intentionally SOFT — a burst arriving inside the cache TTL is admitted against
 * a stale (optimistically-incremented) count; this bounded over-admission is the documented
 * §5.3 cost/latency trade and is absorbed by the per-tier burst allowance (§4.2).
 */
export class RateLimiter {
  private readonly windowMs: number;
  private readonly debounceMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly store: RateLimitStore,
    opts: RateLimiterOptions = {},
  ) {
    this.windowMs = opts.windowMs ?? MINUTE_MS;
    this.debounceMs = opts.debounceMs ?? 1_000;
  }

  async checkAndRecord(keyHash: string, tier: Tier, limitPerMin: number): Promise<RateDecision> {
    const now = Date.now();
    const cacheKey = `${keyHash}:${tier}`;
    const sinceMs = now - this.windowMs;

    // 1. Resolve the window count — debounced to the instance-local cache when fresh.
    const cached = this.cache.get(cacheKey);
    let count: number;
    if (cached && now - cached.fetchedAt < this.debounceMs) {
      count = cached.count;
    } else {
      count = await this.store.countWindow(keyHash, tier, sinceMs);
      this.cache.set(cacheKey, { count, fetchedAt: now });
    }

    // 2. Enforce the per-tier limit.
    if (limitPerMin > 0 && count >= limitPerMin) {
      // Spacing at the limit is a cheap, monotone retry hint (no extra read for oldest tick).
      const retryAfterMs = Math.min(this.windowMs, Math.ceil(this.windowMs / limitPerMin));
      return { allowed: false, count, retryAfterMs };
    }

    // 3. Admit: append the tick (global, append-only) + optimistically bump the cached count.
    const bucketMinute = Math.floor(now / MINUTE_MS);
    await this.store.appendTick(keyHash, {
      tier,
      ts: now,
      bucketMinute,
      expireAt: now + this.windowMs,
    });
    const entry = this.cache.get(cacheKey);
    if (entry) entry.count += 1;
    else this.cache.set(cacheKey, { count: count + 1, fetchedAt: now });

    return { allowed: true, count: count + 1 };
  }
}
