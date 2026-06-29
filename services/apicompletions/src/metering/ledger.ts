// Usage ledger + Pub/Sub rollup (ADR-203 §5.1, agentbbs-gcp pattern).
//   apicompletions --publish--> [Pub/Sub completions-usage] --> gen2 aggregateUsage
//        |-- write --> usage_ledger/{requestId}   (append-only, billing source of truth)
// Ledger write is on the response path (truth); Pub/Sub publish is fire-and-forget (rollup).
import type { Tier } from '../types/openai';

export interface UsageRecord {
  requestId: string;
  keyPrefix: string;
  accountId?: string;
  tier: Tier;
  resolvedModel: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  priceUsd: number;
  escalated: boolean;
  /** §3.5 — honest record of low-tier tokens thrown away by an inflight escalation. */
  discardedPrefixTokens?: number;
  /** §5.1 — set when the client dropped the stream before the final usage frame. */
  truncated?: boolean;
  latencyMs: number;
  idempotencyKey?: string;
  ts: number;
}

/** TODO(impl): write usage_ledger/{requestId} (firebase-admin). */
export async function writeLedger(_record: UsageRecord): Promise<void> {
  throw new Error('not implemented: writeLedger (ADR-203 §5.1)');
}

/** TODO(impl): publish to completions-usage (fire-and-forget; failure logs, never fails the completion). */
export async function publishUsage(_record: UsageRecord): Promise<void> {
  throw new Error('not implemented: publishUsage (ADR-203 §5.1)');
}
