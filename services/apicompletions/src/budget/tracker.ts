// Reserve-and-Commit budget tracker — $0 in-memory implementation (ADR-204 rev-2 §5.2/§5.5).
//
// This is the emulator-first / test binding (same DI posture as InMemoryKeyStore /
// InMemoryLedgerStore): it models the Firestore RESERVE/COMMIT transactions and the
// aggregateUsage reconciler in memory so the whole reserve→invoke→commit loop runs offline at
// $0. Production swaps in FirestoreBudgetTracker (src/budget/firestore.ts), which runs the SAME
// logic inside `firestore.runTransaction`.
//
// Key invariants (mirrored exactly by the Firestore binding):
//   • RESERVE reads ONLY the account doc + ONE agent-shard doc — never scans reservations (§5.2 fix 2).
//   • The per-agent-SHARD cap is the SYNCHRONOUS hard backstop; `headroomExhausted` is the
//     DECOUPLED, eventually-consistent account guard flipped by the reconciler (§5.2 fix 2).
//   • A reservation lease holds headroom until its LOGICAL `expiresAt`; the reconciler reclaims
//     it at expiry — NOT at native-TTL GC (§5.5). This is the crash-recovery path.
//   • COMMIT is IDEMPOTENT on resId (late / replay COMMIT never double-charges, §5.5).
import type { Config } from '../config';
import type {
  AccountDoc,
  AccountStatus,
  AgentShardDoc,
  BudgetTracker,
  ReservationDoc,
  ReserveInput,
  ReserveOutcome,
} from './types';

/** Account seed — caps are required; the rest default to a fresh, active, unexhausted account. */
export interface AccountSeed {
  servingBudgetUsd: number;
  hardCapUsd: number;
  perAgentCapUsd: number;
  shardCount?: number;
  committedUsd?: number;
  reservedUsd?: number;
  headroomExhausted?: boolean;
  status?: AccountStatus;
}

export interface InMemoryBudgetOptions {
  /** Injectable clock (ms) — lets tests advance past a lease `expiresAt` deterministically. */
  now?: () => number;
}

function shardKey(accountId: string, agentId: string, shard: number): string {
  return `${accountId}/${agentId}_${shard}`;
}

/**
 * In-memory Reserve-and-Commit tracker. Unmetered by default: an account with no seeded
 * subscription doc admits every request with no reservation (COMMIT is then a no-op), so the
 * budget layer is transparent until an account opts in via {@link seedAccount}.
 */
export class InMemoryBudgetTracker implements BudgetTracker {
  private readonly accounts = new Map<string, AccountDoc>();
  private readonly shards = new Map<string, AgentShardDoc>();
  private readonly reservations = new Map<string, ReservationDoc>();
  private readonly now: () => number;

  constructor(private readonly config: Config, opts: InMemoryBudgetOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Seed (or overwrite) the account budget doc — the opt-in to enforcement. */
  seedAccount(accountId: string, seed: AccountSeed): AccountDoc {
    const doc: AccountDoc = {
      servingBudgetUsd: seed.servingBudgetUsd,
      hardCapUsd: seed.hardCapUsd,
      perAgentCapUsd: seed.perAgentCapUsd,
      shardCount: seed.shardCount ?? this.config.budget.shardCount,
      committedUsd: seed.committedUsd ?? 0,
      reservedUsd: seed.reservedUsd ?? 0,
      headroomExhausted: seed.headroomExhausted ?? false,
      status: seed.status ?? 'active',
    };
    this.accounts.set(accountId, doc);
    return doc;
  }

  getAccount(accountId: string): AccountDoc | undefined {
    return this.accounts.get(accountId);
  }
  getShard(accountId: string, agentId: string, shard: number): AgentShardDoc | undefined {
    return this.shards.get(shardKey(accountId, agentId, shard));
  }
  getReservation(resId: string): ReservationDoc | undefined {
    return this.reservations.get(resId);
  }

  private shardFor(acct: AccountDoc, accountId: string, agentId: string, shard: number): AgentShardDoc {
    const key = shardKey(accountId, agentId, shard);
    let doc = this.shards.get(key);
    if (!doc) {
      doc = {
        reservedUsd: 0,
        committedUsd: 0,
        perShardCapUsd: acct.perAgentCapUsd / acct.shardCount,
        invokeCount: 0,
        windowStart: this.now(),
      };
      this.shards.set(key, doc);
    }
    return doc;
  }

  /**
   * RESERVE (atomic, pre-invoke) — the deny boundary (§5.2). Reads the account doc + ONE
   * agent-shard doc only. Account guard is the decoupled `headroomExhausted`/`status` flag;
   * the per-shard cap is the synchronous hard backstop; loop-rate is per shard.
   */
  async reserve(input: ReserveInput): Promise<ReserveOutcome> {
    const acct = this.accounts.get(input.accountId);
    if (!acct) return { admit: true }; // unmetered account → transparent (no reservation)

    // (1) account-wide guard — DECOUPLED, eventually-consistent (rev-2 fix 2). NO subcollection scan.
    if (acct.status !== 'active' || acct.headroomExhausted) {
      return {
        admit: false,
        status: 402,
        code: 'account_budget_exhausted',
        error: 'Account budget exhausted for the current period.',
      };
    }

    const K = acct.shardCount;
    const shard = input.shard ?? Math.floor(Math.random() * K);
    const shardDoc = this.shardFor(acct, input.accountId, input.agentId, shard);
    const now = this.now();

    // Roll the loop-rate window forward if it has elapsed.
    if (now - shardDoc.windowStart > this.config.budget.loopWindowMs) {
      shardDoc.windowStart = now;
      shardDoc.invokeCount = 0;
    }
    // (2a) per-shard loop-rate cap = maxLoopRate / K (§5.2). Cross-refs ADR-203 §3.5 terminate.
    const perShardLoopCap = Math.max(1, Math.ceil(this.config.budget.maxLoopRatePerMin / K));
    if (shardDoc.invokeCount >= perShardLoopCap) {
      return {
        admit: false,
        status: 429,
        code: 'loop_detected',
        error: 'Agent loop-rate cap exceeded — too many reservations in the window.',
      };
    }

    // (2b) per-agent-SHARD runaway cap — the SYNCHRONOUS hard backstop (rev-2 fix 1).
    if (shardDoc.reservedUsd + shardDoc.committedUsd + input.estimateUsd > shardDoc.perShardCapUsd) {
      return {
        admit: false,
        status: 402,
        code: 'agent_budget_exhausted',
        error: 'Per-agent budget cap exhausted — this agent cannot run away.',
      };
    }

    // (3) write the reservation lease (the WAL-frame write).
    shardDoc.reservedUsd += input.estimateUsd;
    shardDoc.invokeCount += 1;
    const lease =
      input.reqType === 'streaming'
        ? this.config.budget.leaseStreamMs
        : this.config.budget.leaseSyncMs;
    const res: ReservationDoc = {
      accountId: input.accountId,
      agentId: input.agentId,
      shard,
      amountUsd: input.estimateUsd,
      ceilingTier: input.ceilingTier,
      createdAt: now,
      expiresAt: now + lease,
      state: 'active',
    };
    this.reservations.set(input.resId, res);

    // SOFT cap is a warn, not a deny (§5.2): surfaced eventually-consistently by the rollup, but
    // we also flag here when the rollup already knows the account is over the serving budget.
    const fairUseWarning = acct.committedUsd + acct.reservedUsd > acct.servingBudgetUsd;
    return { admit: true, resId: input.resId, shard, fairUseWarning };
  }

  /**
   * COMMIT (atomic, post-invoke) — actual known (§5.2). Idempotent on resId: a replay or a
   * late finish past the lease still books once without double-charging. Releases the lease
   * estimate (even if it already lapsed) and records the actual on the shard.
   */
  async commit(resId: string, actualUsd: number): Promise<void> {
    const res = this.reservations.get(resId);
    if (!res) return; // unmetered / nothing reserved → no-op
    if (res.state === 'committed') return; // replay / already-committed → no double-charge

    const shardDoc = this.shards.get(shardKey(res.accountId, res.agentId, res.shard));
    if (shardDoc) {
      shardDoc.reservedUsd = Math.max(0, shardDoc.reservedUsd - res.amountUsd);
      shardDoc.committedUsd += actualUsd;
    }
    res.state = 'committed';
    res.actualUsd = actualUsd;
  }

  /**
   * Reconciler — rides the aggregateUsage cadence (§5.5), NOT a separate cron. For an account:
   *   1. recompute each shard's reservedUsd as Σ active leases WHERE expiresAt>now (excludes
   *      lapsed leases → reclaims a crashed agent's headroom at lease expiry, the §5.5 path);
   *   2. recompute committed+reserved and flip `headroomExhausted` on the account doc (§5.2);
   *   3. mark lapsed leases `state:'expired'` (native TTL would later GC the row — cosmetic).
   */
  reconcile(accountId: string): void {
    const acct = this.accounts.get(accountId);
    if (!acct) return;
    const now = this.now();

    // Per-shard live reservation sum over non-expired active leases.
    const reservedByShard = new Map<string, number>();
    let totalReserved = 0;
    for (const res of this.reservations.values()) {
      if (res.accountId !== accountId || res.state !== 'active') continue;
      if (res.expiresAt > now) {
        const key = shardKey(res.accountId, res.agentId, res.shard);
        reservedByShard.set(key, (reservedByShard.get(key) ?? 0) + res.amountUsd);
        totalReserved += res.amountUsd;
      } else {
        res.state = 'expired'; // §5.5 — lapsed lease; row GC'd later by native TTL (cosmetic)
      }
    }

    // Reset each of the account's shards to the recomputed active-lease sum (reclaims headroom).
    const prefix = `${accountId}/`;
    let totalCommitted = 0;
    for (const [key, shardDoc] of this.shards) {
      if (!key.startsWith(prefix)) continue;
      shardDoc.reservedUsd = reservedByShard.get(key) ?? 0;
      totalCommitted += shardDoc.committedUsd;
    }

    acct.committedUsd = totalCommitted;
    acct.reservedUsd = totalReserved;
    // §5.2 — the decoupled, eventually-consistent hot-path guard.
    acct.headroomExhausted = totalCommitted + totalReserved >= acct.hardCapUsd;
  }
}

/**
 * A transparent tracker that admits everything and never reserves — the explicit "budget
 * defense off" binding. (The default deps use {@link InMemoryBudgetTracker} with no seeded
 * accounts, which is equivalently transparent but can be opted into per-account.)
 */
export class NoopBudgetTracker implements BudgetTracker {
  async reserve(): Promise<ReserveOutcome> {
    return { admit: true };
  }
  async commit(): Promise<void> {
    /* no-op */
  }
}
