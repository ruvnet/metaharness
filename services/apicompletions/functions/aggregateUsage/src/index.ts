// gen2 Cloud Function `aggregateUsage` (ADR-203 §5.1, §7.1) — Pub/Sub-triggered, folds
// completions-usage events into usage_rollups/{accountId}/{YYYY-MM}. Mirrors the
// agentbbs-gcp `aggregateSysopReport` shape (ALLOW_INTERNAL_ONLY). Separate deploy unit
// from the Cloud Run service (deferred — Phase-6, rollout step 6).
//
// TODO(impl): firebase-functions/v2 onMessagePublished('completions-usage') →
//             transactional fold into usage_rollups by tier/model. Stub for now.

export interface UsageEvent {
  accountId?: string;
  tier: string;
  resolvedModel: string;
  totalTokens: number;
  priceUsd: number;
  ts: number;
}

export function fold(_event: UsageEvent): void {
  throw new Error('not implemented: aggregateUsage.fold (ADR-203 §5.1)');
}
