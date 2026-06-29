// Reserve-and-Commit budget tracker — production Firestore binding (ADR-204 rev-2 §5.2/§5.5).
//
// Runs the SAME RESERVE/COMMIT logic as InMemoryBudgetTracker, but inside
// `firestore.runTransaction` so the deny boundary is atomic (an overspend is impossible). It is
// structurally typed against {@link FirestoreLike} (no hard firebase-admin import — same deferred-
// dep posture as FirestoreLedgerStore) so the standalone build stays green; the production
// binding is `new FirestoreBudgetTracker(admin.firestore(), config)`.
//
// Collections (top-level, per the ADR-204 §5.2 data model):
//   subscriptions/{accountId}                 — account rollup (read-hot)
//   agents/{accountId}__{agentId}_{shard}     — per-agent SHARDED tracker (txn unit; account-
//                                               namespaced so the same agentId across accounts
//                                               cannot collide on one doc)
//   reservations/{resId}                      — reservation lease (carries accountId/agentId/shard
//                                               so COMMIT resolves the shard doc from resId alone)
//
// RESERVE reads exactly TWO single docs (account + shard) — never scans `reservations` (§5.2 fix 2).
import type { Config } from '../config';
import type { FirestoreLike, TransactionLike } from '../firestore/client';
import type {
  AccountDoc,
  AgentShardDoc,
  BudgetTracker,
  ReservationDoc,
  ReserveInput,
  ReserveOutcome,
} from './types';

function agentDocId(accountId: string, agentId: string, shard: number): string {
  return `${accountId}__${agentId}_${shard}`;
}

export class FirestoreBudgetTracker implements BudgetTracker {
  constructor(
    private readonly db: FirestoreLike,
    private readonly config: Config,
  ) {}

  async reserve(input: ReserveInput): Promise<ReserveOutcome> {
    const acctRef = this.db.collection('subscriptions').doc(input.accountId);

    return this.db.runTransaction(async (txn: TransactionLike): Promise<ReserveOutcome> => {
      const acctSnap = await txn.get(acctRef);
      if (!acctSnap.exists) return { admit: true }; // unmetered account → transparent
      const acct = acctSnap.data() as unknown as AccountDoc;

      // (1) account-wide guard — DECOUPLED, eventually-consistent flag (rev-2 fix 2). No scan.
      if (acct.status !== 'active' || acct.headroomExhausted) {
        return {
          admit: false,
          status: 402,
          code: 'account_budget_exhausted',
          error: 'Account budget exhausted for the current period.',
        };
      }

      const K = acct.shardCount ?? this.config.budget.shardCount;
      const shard = input.shard ?? Math.floor(Math.random() * K);
      const shardRef = this.db.collection('agents').doc(agentDocId(input.accountId, input.agentId, shard));
      const shardSnap = await txn.get(shardRef);
      const now = Date.now();
      const perShardCapUsd = acct.perAgentCapUsd / K;
      const cur: AgentShardDoc = shardSnap.exists
        ? (shardSnap.data() as unknown as AgentShardDoc)
        : { reservedUsd: 0, committedUsd: 0, perShardCapUsd, invokeCount: 0, windowStart: now };

      // Roll the per-shard loop-rate window forward if it has elapsed.
      let invokeCount = cur.invokeCount;
      let windowStart = cur.windowStart;
      if (now - windowStart > this.config.budget.loopWindowMs) {
        windowStart = now;
        invokeCount = 0;
      }
      // (2a) per-shard loop-rate cap = maxLoopRate / K (cross-ref ADR-203 §3.5 terminate).
      const perShardLoopCap = Math.max(1, Math.ceil(this.config.budget.maxLoopRatePerMin / K));
      if (invokeCount >= perShardLoopCap) {
        return {
          admit: false,
          status: 429,
          code: 'loop_detected',
          error: 'Agent loop-rate cap exceeded — too many reservations in the window.',
        };
      }

      // (2b) per-agent-SHARD runaway cap — the SYNCHRONOUS hard backstop (rev-2 fix 1).
      const cap = cur.perShardCapUsd ?? perShardCapUsd;
      if (cur.reservedUsd + cur.committedUsd + input.estimateUsd > cap) {
        return {
          admit: false,
          status: 402,
          code: 'agent_budget_exhausted',
          error: 'Per-agent budget cap exhausted — this agent cannot run away.',
        };
      }

      // (3) write the shard counter + the reservation lease (the WAL-frame write).
      txn.set(
        shardRef,
        {
          reservedUsd: cur.reservedUsd + input.estimateUsd,
          committedUsd: cur.committedUsd,
          perShardCapUsd: cap,
          invokeCount: invokeCount + 1,
          windowStart,
        },
        { merge: true },
      );
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
      txn.set(this.db.collection('reservations').doc(input.resId), { ...res });

      const fairUseWarning = acct.committedUsd + acct.reservedUsd > acct.servingBudgetUsd;
      return { admit: true, resId: input.resId, shard, fairUseWarning };
    });
  }

  async commit(resId: string, actualUsd: number): Promise<void> {
    const resRef = this.db.collection('reservations').doc(resId);
    await this.db.runTransaction(async (txn: TransactionLike): Promise<void> => {
      const resSnap = await txn.get(resRef);
      if (!resSnap.exists) return; // unmetered / nothing reserved → no-op
      const res = resSnap.data() as unknown as ReservationDoc;
      if (res.state === 'committed') return; // replay / already-committed → no double-charge

      const shardRef = this.db.collection('agents').doc(agentDocId(res.accountId, res.agentId, res.shard));
      const shardSnap = await txn.get(shardRef);
      if (shardSnap.exists) {
        const cur = shardSnap.data() as unknown as AgentShardDoc;
        txn.update(shardRef, {
          reservedUsd: Math.max(0, cur.reservedUsd - res.amountUsd), // release the lease
          committedUsd: cur.committedUsd + actualUsd, // record what was really spent
        });
      }
      txn.update(resRef, { state: 'committed', actualUsd });
    });
  }
}
