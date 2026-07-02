// gen2 Cloud Function `aggregateUsage` (ADR-203 §5.1, §7.1) — Pub/Sub-triggered, folds
// completions-usage events into usage_rollups/{accountId}/{YYYY-MM}. Mirrors the
// agentbbs-gcp `aggregateSysopReport` shape (ALLOW_INTERNAL_ONLY). Separate deploy unit
// from the Cloud Run service (rollout step 6).
//
// The FOLD is pure + framework-free (testable at $0); the firebase-functions/v2
// `onMessagePublished('completions-usage')` trigger is a thin wrapper bound at deploy
// (firebase-functions is a deferred dep, kept out of the standalone build). The rollup
// store is structurally typed so it binds to firebase-admin Firestore in production and an
// in-memory fake in tests — the same DI posture as the Cloud Run service's metering stores.

export interface UsageEvent {
  accountId?: string;
  tier: string;
  resolvedModel: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  priceUsd: number;
  ts: number;
}

export interface RollupBucket {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  priceUsd: number;
}

export interface RollupDoc {
  accountId: string;
  /** YYYY-MM (UTC). */
  period: string;
  byTier: Record<string, RollupBucket>;
  byModel: Record<string, RollupBucket>;
  totals: RollupBucket;
  updatedAt: number;
}

const UNATTRIBUTED = '_unattributed';

/** YYYY-MM (UTC) billing period for an epoch-ms timestamp. */
export function periodOf(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function emptyBucket(): RollupBucket {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, priceUsd: 0 };
}

function addInto(b: RollupBucket, e: UsageEvent): void {
  b.requests += 1;
  b.promptTokens += e.promptTokens;
  b.completionTokens += e.completionTokens;
  b.totalTokens += e.totalTokens;
  b.priceUsd += e.priceUsd;
}

/**
 * Pure fold: accumulate one usage event into the (possibly null) prior rollup doc,
 * returning the new doc. Totals + per-tier + per-model buckets (mirrors agentbbs-gcp).
 */
export function fold(prev: RollupDoc | null, event: UsageEvent): RollupDoc {
  const accountId = event.accountId ?? UNATTRIBUTED;
  const period = periodOf(event.ts);
  const doc: RollupDoc = prev ?? {
    accountId,
    period,
    byTier: {},
    byModel: {},
    totals: emptyBucket(),
    updatedAt: 0,
  };
  doc.byTier[event.tier] ??= emptyBucket();
  doc.byModel[event.resolvedModel] ??= emptyBucket();
  addInto(doc.byTier[event.tier], event);
  addInto(doc.byModel[event.resolvedModel], event);
  addInto(doc.totals, event);
  doc.updatedAt = Date.now();
  return doc;
}

/** Structural rollup store — Firestore in production, in-memory in tests. */
export interface RollupStore {
  get(accountId: string, period: string): Promise<RollupDoc | null>;
  set(doc: RollupDoc): Promise<void>;
}

/** $0 in-memory rollup store for the fold unit tests. */
export class InMemoryRollupStore implements RollupStore {
  private readonly byKey = new Map<string, RollupDoc>();
  private k(accountId: string, period: string): string {
    return `${accountId}/${period}`;
  }
  async get(accountId: string, period: string): Promise<RollupDoc | null> {
    return this.byKey.get(this.k(accountId, period)) ?? null;
  }
  async set(doc: RollupDoc): Promise<void> {
    this.byKey.set(this.k(doc.accountId, doc.period), doc);
  }
}

/**
 * Read-fold-write one event into usage_rollups. In production this runs inside a Firestore
 * transaction (the agentbbs-gcp `aggregateSysopReport` pattern) so concurrent events for the
 * same account/period serialize correctly; the in-memory store models the same read→write.
 */
export async function aggregate(store: RollupStore, event: UsageEvent): Promise<RollupDoc> {
  const accountId = event.accountId ?? UNATTRIBUTED;
  const period = periodOf(event.ts);
  const prev = await store.get(accountId, period);
  const next = fold(prev, event);
  await store.set(next);
  return next;
}
