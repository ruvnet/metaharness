// Metering write helper (ADR-203 §5.1). Assembles the UsageRecord, writes it to the
// ledger (TRUTH — awaited on the response path so billing is never lost), then fires the
// Pub/Sub publish (rollup — fire-and-forget). A failure on EITHER surface logs but never
// fails the customer's completion: the ledger write is wrapped so a Firestore blip downgrades
// to a logged error rather than a 5xx, and the publish is detached.
import type { AppDeps } from '../deps';
import type { ApiKeyDoc } from '../auth/apiKey';
import type { Tier, Usage } from '../types/openai';
import type { UsageRecord } from './ledger';

export interface MeterInput {
  requestId: string;
  key: ApiKeyDoc;
  keyPrefix: string;
  tier: Tier;
  resolvedModel: string;
  usage: Usage;
  priceUsd: number;
  escalated: boolean;
  latencyMs: number;
  tokensFromLocalFloor: boolean;
  idempotencyKey?: string;
  truncated?: boolean;
  discardedPrefixTokens?: number;
}

export function buildRecord(input: MeterInput): UsageRecord {
  return {
    requestId: input.requestId,
    keyPrefix: input.keyPrefix,
    accountId: input.key.accountId,
    tier: input.tier,
    resolvedModel: input.resolvedModel,
    promptTokens: input.usage.prompt_tokens,
    completionTokens: input.usage.completion_tokens,
    totalTokens: input.usage.total_tokens,
    priceUsd: input.priceUsd,
    escalated: input.escalated,
    truncated: input.truncated,
    discardedPrefixTokens: input.discardedPrefixTokens,
    tokensFromLocalFloor: input.tokensFromLocalFloor,
    latencyMs: input.latencyMs,
    idempotencyKey: input.idempotencyKey,
    ts: Date.now(),
  };
}

/**
 * Write the ledger row (truth, awaited) and publish the rollup event (fire-and-forget).
 * Never throws to the caller — a metering failure must not fail the completion (§5.1).
 */
export async function meter(deps: AppDeps, input: MeterInput): Promise<UsageRecord> {
  const record = buildRecord(input);
  try {
    await deps.ledger.write(record);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[metering] usage_ledger write failed for ${record.requestId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // Detached — publish() swallows its own errors; .catch() guards a rejected promise too.
  void deps.usagePublisher.publish(record).catch(() => undefined);
  return record;
}
