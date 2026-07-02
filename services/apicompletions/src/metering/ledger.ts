// Usage ledger + Pub/Sub rollup (ADR-203 §5.1, agentbbs-gcp pattern).
//   apicompletions --publish--> [Pub/Sub completions-usage] --> gen2 aggregateUsage
//        |-- write --> usage_ledger/{requestId}   (append-only, billing source of truth)
// Ledger write is on the response path (truth); Pub/Sub publish is fire-and-forget (rollup).
//
// Both surfaces are dependency-injected behind small interfaces (the same DI posture as
// `KeyStore`): in-memory fakes run the whole meter→bill loop at $0 in tests/emulators;
// production binds the Firestore-/PubSub-backed adapters. A metering failure LOGS but
// NEVER fails the customer's completion — the ledger write is awaited on the response path
// so billing is not lost, the publish is fire-and-forget (the rollup is reconstructable).
import type { Tier } from '../types/openai';
import type { FirestoreLike, PubSubTopicLike } from '../firestore/client';

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
  /** §5.1 — true when the count came from the local family floor, not the provider. */
  tokensFromLocalFloor?: boolean;
  latencyMs: number;
  idempotencyKey?: string;
  ts: number;
}

/** The billing source of truth (§5.1). Append-only by request id; reconcilable. */
export interface LedgerStore {
  /** Write usage_ledger/{requestId}. Awaited on the response path so billing is not lost. */
  write(record: UsageRecord): Promise<void>;
}

/** Fire-and-forget rollup feed (§5.1). publish() must NEVER throw to the caller. */
export interface UsagePublisher {
  publish(record: UsageRecord): Promise<void>;
}

/** $0 emulator-first / test ledger. Append-only keyed by requestId; later writes (provider
 *  reconcile) overwrite the floor row for the same request. */
export class InMemoryLedgerStore implements LedgerStore {
  private readonly byRequest = new Map<string, UsageRecord>();

  async write(record: UsageRecord): Promise<void> {
    this.byRequest.set(record.requestId, { ...record });
  }

  /** Test/inspection helpers — not part of the production interface. */
  all(): UsageRecord[] {
    return [...this.byRequest.values()];
  }
  get(requestId: string): UsageRecord | undefined {
    return this.byRequest.get(requestId);
  }
  get size(): number {
    return this.byRequest.size;
  }
}

/** $0 in-memory publisher. Records every published event; never throws (fire-and-forget). */
export class InMemoryUsagePublisher implements UsagePublisher {
  readonly published: UsageRecord[] = [];

  async publish(record: UsageRecord): Promise<void> {
    this.published.push({ ...record });
  }
}

/**
 * Production ledger — writes usage_ledger/{requestId} via firebase-admin (structurally
 * typed against {@link FirestoreLike} so the SDK stays a deferred dep). `merge:true` lets
 * a later provider-authoritative reconcile update the floor row idempotently.
 */
export class FirestoreLedgerStore implements LedgerStore {
  constructor(private readonly db: FirestoreLike) {}

  async write(record: UsageRecord): Promise<void> {
    await this.db
      .collection('usage_ledger')
      .doc(record.requestId)
      .set({ ...record }, { merge: true });
  }
}

/**
 * Production publisher — publishes to the `completions-usage` Pub/Sub topic (agentbbs-gcp
 * async-HTTP bridge shape, §5.1). Swallows + logs on failure: the rollup is reconstructable
 * from the ledger, so a publish error must never surface to the customer.
 */
export class PubSubUsagePublisher implements UsagePublisher {
  constructor(private readonly topic: PubSubTopicLike) {}

  async publish(record: UsageRecord): Promise<void> {
    try {
      await this.topic.publishMessage({ json: record });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[metering] completions-usage publish failed (rollup only, billing safe): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
