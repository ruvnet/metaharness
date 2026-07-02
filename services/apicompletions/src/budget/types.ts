// Reserve-and-Commit budget data model (ADR-204 rev-2 §5.2/§5.5).
//
// Three Firestore doc shapes:
//   subscriptions/{accountId}                       — account rollup (read-hot, write-cold)
//   subscriptions/{accountId}/agents/{agentId}_{s}  — per-agent SHARDED tracker (txn unit)
//   subscriptions/{accountId}/reservations/{resId}  — reservation LEASE (WAL-frame analog)
//
// The account doc carries a DECOUPLED, eventually-consistent `headroomExhausted` flag (§5.2
// fix 2) flipped by the async aggregateUsage rollup — the RESERVE txn reads it cheaply instead
// of scanning the reservations subcollection. The per-agent-SHARD cap is the SYNCHRONOUS hard
// backstop. A reservation lease carries a LOGICAL `expiresAt` the rollup RESPECTS (§5.5) so a
// crashed agent's headroom is reclaimed at lease expiry — NOT at native-TTL GC.
import type { Tier } from '../types/openai';

export type AccountStatus = 'active' | 'throttled' | 'suspended';
export type ReservationState = 'active' | 'committed' | 'expired';

/** subscriptions/{accountId} — the account budget rollup (ADR-204 §5.2 data model). */
export interface AccountDoc {
  /** SOFT fair-use ceiling for the period (warn, not deny). */
  servingBudgetUsd: number;
  /** ABSOLUTE ceiling — committed+reserved beyond this flips `headroomExhausted`. */
  hardCapUsd: number;
  /** Per-agent / per-loop runaway cap; split across K shards as perShardCap = this / K. */
  perAgentCapUsd: number;
  /** K — number of shards the per-agent cap is spread across (§5.2 fix 1). */
  shardCount: number;
  /** Folded actuals (async, via the §5.1 Pub/Sub aggregateUsage fold). */
  committedUsd: number;
  /** Live reservation buffer = Σ active leases WHERE expiresAt>now (recomputed by the rollup). */
  reservedUsd: number;
  /** rev-2 fix 2: set by aggregateUsage when committed+reserved ≥ hardCap. The hot-path guard. */
  headroomExhausted: boolean;
  status: AccountStatus;
}

/** subscriptions/{accountId}/agents/{agentId}_{shard} — the per-agent SHARDED txn unit. */
export interface AgentShardDoc {
  /** Outstanding reservations on THIS shard not yet committed. */
  reservedUsd: number;
  /** Actuals committed on THIS shard. */
  committedUsd: number;
  /** perAgentCapUsd / K — the per-agent runaway cap split across K shards. */
  perShardCapUsd: number;
  /** Rolling-window invoke count → loop-rate detection (per shard). */
  invokeCount: number;
  /** Start of the current loop-rate window. */
  windowStart: number;
}

/** subscriptions/{accountId}/reservations/{resId} — the reservation lease (§5.5). */
export interface ReservationDoc {
  accountId: string;
  agentId: string;
  shard: number;
  /** Worst-case estimate at ceilingTier (the headroom this lease holds). */
  amountUsd: number;
  ceilingTier: Tier;
  createdAt: number;
  /** LOGICAL lease deadline the headroom rollup RESPECTS (§5.5) — not a delete timer. */
  expiresAt: number;
  state: ReservationState;
  /** Set at COMMIT. */
  actualUsd?: number;
}

/** Request class → lease window (§5.5): short for sync, long for streaming/agentic. */
export type RequestType = 'sync' | 'streaming';

export interface ReserveInput {
  accountId: string;
  agentId: string;
  /** Ceiling tier escalation can reach — the worst-case estimate is priced here (§5.2). */
  ceilingTier: Tier;
  /** Worst-case estimateUsd = prompt·Rate_In[ceiling] + maxTokens·Rate_Out[ceiling]. */
  estimateUsd: number;
  reqType: RequestType;
  /** Reservation id (one per request); ties COMMIT idempotency to the request. */
  resId: string;
  /** Explicit shard (tests / deterministic routing); else random/round-robin per §5.2. */
  shard?: number;
}

/**
 * RESERVE outcome. `admit:true` with no `resId` means the account is UNMETERED (no
 * subscription doc) — the request proceeds and COMMIT is a no-op. A denial carries the
 * ADR-204 wire code: 402 account/agent budget exhausted, 429 loop detected.
 */
export type ReserveOutcome =
  | { admit: true; resId?: string; shard?: number; fairUseWarning?: boolean }
  | { admit: false; status: number; code: string; error: string };

/**
 * The Reserve-and-Commit budget tracker (ADR-204 §5.2). RESERVE is the pre-invoke deny
 * boundary (an overspend is impossible — no reservation, no invoke); COMMIT books the
 * actual post-invoke and is IDEMPOTENT on resId.
 */
export interface BudgetTracker {
  reserve(input: ReserveInput): Promise<ReserveOutcome>;
  /** Release the estimate, record the actual. Idempotent on resId (late/replay COMMIT safe). */
  commit(resId: string, actualUsd: number): Promise<void>;
}
