// Reserve-and-Commit budget tracker — emulator-first ($0, in-memory) tests (ADR-204 rev-2
// §5.2/§5.5). Exercises the deny boundary (over-cap → 402), the reserve→commit happy path,
// crash (no commit) → lease expiry → headroom recovery, shard isolation, and idempotent late
// COMMIT — plus the request-path wiring (reserve→invoke→commit) end-to-end via the mock provider.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createAppWith } from '../src/server';
import { COMPLETION_SCOPES, InMemoryKeyStore } from '../src/auth/apiKey';
import { InMemoryBudgetTracker } from '../src/budget/tracker';
import { worstCaseEstimateUsd, promptTokenFloor } from '../src/budget/estimate';
import { loadConfig } from '../src/config';

const KEY = 'cog_' + '7'.repeat(64);

function keyStore(accountId = 'acct-1'): InMemoryKeyStore {
  const s = new InMemoryKeyStore();
  s.add(KEY, {
    permissions: [COMPLETION_SCOPES.low, COMPLETION_SCOPES.mid, COMPLETION_SCOPES.high],
    rateLimit: 1000,
    active: true,
    expiresAt: null,
    accountId,
  });
  return s;
}

// A controllable clock so lease-expiry / recovery is deterministic.
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// ───────────────────── Unit: the tracker mechanism (§5.2/§5.5) ─────────────────────
describe('budget tracker — Reserve-and-Commit unit semantics (ADR-204 §5.2/§5.5)', () => {
  const cfg = loadConfig();

  it('unmetered account (no subscription doc) admits transparently with no reservation', async () => {
    const t = new InMemoryBudgetTracker(cfg);
    const out = await t.reserve({ accountId: 'nobody', agentId: 'a', ceilingTier: 'high', estimateUsd: 9999, reqType: 'sync', resId: 'r1' });
    expect(out.admit).toBe(true);
    if (out.admit) expect(out.resId).toBeUndefined();
    await t.commit('r1', 1); // no-op, must not throw
  });

  it('reserve → commit happy path: estimate held then released, actual booked', async () => {
    const t = new InMemoryBudgetTracker(cfg);
    t.seedAccount('acct', { servingBudgetUsd: 10, hardCapUsd: 20, perAgentCapUsd: 8, shardCount: 4 });
    const out = await t.reserve({ accountId: 'acct', agentId: 'ag', ceilingTier: 'low', estimateUsd: 0.5, reqType: 'sync', resId: 'r1', shard: 0 });
    expect(out.admit).toBe(true);
    const shardAfterReserve = t.getShard('acct', 'ag', 0)!;
    expect(shardAfterReserve.reservedUsd).toBeCloseTo(0.5, 9);
    expect(shardAfterReserve.committedUsd).toBe(0);

    await t.commit('r1', 0.2); // actual < estimate → gap returns to headroom
    const shardAfterCommit = t.getShard('acct', 'ag', 0)!;
    expect(shardAfterCommit.reservedUsd).toBeCloseTo(0, 9);
    expect(shardAfterCommit.committedUsd).toBeCloseTo(0.2, 9);
    expect(t.getReservation('r1')!.state).toBe('committed');
  });

  it('over-cap → 402: a worst-case estimate beyond the per-shard cap is denied at RESERVE', async () => {
    const t = new InMemoryBudgetTracker(cfg);
    // perAgentCap 4 over K=4 → perShardCap 1.0; estimate 1.5 exceeds it.
    t.seedAccount('acct', { servingBudgetUsd: 10, hardCapUsd: 20, perAgentCapUsd: 4, shardCount: 4 });
    const out = await t.reserve({ accountId: 'acct', agentId: 'ag', ceilingTier: 'high', estimateUsd: 1.5, reqType: 'sync', resId: 'r1', shard: 0 });
    expect(out.admit).toBe(false);
    if (!out.admit) {
      expect(out.status).toBe(402);
      expect(out.code).toBe('agent_budget_exhausted');
    }
  });

  it('over-cap → 402: a headroom-exhausted account denies before touching any shard', async () => {
    const t = new InMemoryBudgetTracker(cfg);
    t.seedAccount('acct', { servingBudgetUsd: 10, hardCapUsd: 5, perAgentCapUsd: 100, shardCount: 4, headroomExhausted: true });
    const out = await t.reserve({ accountId: 'acct', agentId: 'ag', ceilingTier: 'low', estimateUsd: 0.01, reqType: 'sync', resId: 'r1', shard: 0 });
    expect(out.admit).toBe(false);
    if (!out.admit) {
      expect(out.status).toBe(402);
      expect(out.code).toBe('account_budget_exhausted');
    }
  });

  it('suspended account denies at RESERVE (status guard)', async () => {
    const t = new InMemoryBudgetTracker(cfg);
    t.seedAccount('acct', { servingBudgetUsd: 10, hardCapUsd: 20, perAgentCapUsd: 8, shardCount: 4, status: 'suspended' });
    const out = await t.reserve({ accountId: 'acct', agentId: 'ag', ceilingTier: 'low', estimateUsd: 0.1, reqType: 'sync', resId: 'r1', shard: 0 });
    expect(out.admit).toBe(false);
    if (!out.admit) expect(out.code).toBe('account_budget_exhausted');
  });

  it('crash (no commit) → lease expires → reconcile reclaims headroom → next reserve admits', async () => {
    const c = clock();
    const t = new InMemoryBudgetTracker(cfg, { now: c.now });
    // perShardCap 1.0; a single reservation of 0.9 nearly fills it.
    t.seedAccount('acct', { servingBudgetUsd: 10, hardCapUsd: 20, perAgentCapUsd: 4, shardCount: 4 });
    const first = await t.reserve({ accountId: 'acct', agentId: 'ag', ceilingTier: 'high', estimateUsd: 0.9, reqType: 'sync', resId: 'r1', shard: 0 });
    expect(first.admit).toBe(true);
    // Agent crashes — r1 never commits. A second reserve of 0.9 would breach 1.0 → denied now.
    const blocked = await t.reserve({ accountId: 'acct', agentId: 'ag', ceilingTier: 'high', estimateUsd: 0.9, reqType: 'sync', resId: 'r2', shard: 0 });
    expect(blocked.admit).toBe(false);

    // Advance past the sync lease (~60s) and run the reconciler — the lapsed lease stops
    // consuming headroom (§5.5 expiresAt>now predicate), so the shard reservedUsd resets.
    c.advance(cfg.budget.leaseSyncMs + 1);
    t.reconcile('acct');
    expect(t.getShard('acct', 'ag', 0)!.reservedUsd).toBeCloseTo(0, 9);
    expect(t.getReservation('r1')!.state).toBe('expired');

    const recovered = await t.reserve({ accountId: 'acct', agentId: 'ag', ceilingTier: 'high', estimateUsd: 0.9, reqType: 'sync', resId: 'r3', shard: 0 });
    expect(recovered.admit).toBe(true);
  });

  it('shard isolation: filling shard 0 to its cap does not deny shard 1 of the same agent', async () => {
    const t = new InMemoryBudgetTracker(cfg);
    t.seedAccount('acct', { servingBudgetUsd: 10, hardCapUsd: 20, perAgentCapUsd: 4, shardCount: 4 }); // perShardCap 1.0
    const fill0 = await t.reserve({ accountId: 'acct', agentId: 'ag', ceilingTier: 'high', estimateUsd: 1.0, reqType: 'sync', resId: 'r0', shard: 0 });
    expect(fill0.admit).toBe(true);
    const deny0 = await t.reserve({ accountId: 'acct', agentId: 'ag', ceilingTier: 'high', estimateUsd: 0.1, reqType: 'sync', resId: 'r0b', shard: 0 });
    expect(deny0.admit).toBe(false); // shard 0 is full
    const ok1 = await t.reserve({ accountId: 'acct', agentId: 'ag', ceilingTier: 'high', estimateUsd: 1.0, reqType: 'sync', resId: 'r1', shard: 1 });
    expect(ok1.admit).toBe(true); // shard 1 untouched
  });

  it('idempotent late COMMIT: a finish past the lease books once; a replayed COMMIT is a no-op', async () => {
    const c = clock();
    const t = new InMemoryBudgetTracker(cfg, { now: c.now });
    t.seedAccount('acct', { servingBudgetUsd: 10, hardCapUsd: 20, perAgentCapUsd: 8, shardCount: 4 });
    await t.reserve({ accountId: 'acct', agentId: 'ag', ceilingTier: 'low', estimateUsd: 0.5, reqType: 'sync', resId: 'r1', shard: 0 });
    // The request runs PAST its lease, then commits late.
    c.advance(cfg.budget.leaseSyncMs + 1);
    await t.commit('r1', 0.3);
    const shard1 = t.getShard('acct', 'ag', 0)!;
    expect(shard1.committedUsd).toBeCloseTo(0.3, 9);
    expect(shard1.reservedUsd).toBeCloseTo(0, 9);
    // Replayed COMMIT must not double-charge.
    await t.commit('r1', 0.3);
    expect(t.getShard('acct', 'ag', 0)!.committedUsd).toBeCloseTo(0.3, 9);
  });

  it('reconcile flips headroomExhausted once committed+reserved ≥ hardCap', async () => {
    const t = new InMemoryBudgetTracker(cfg);
    t.seedAccount('acct', { servingBudgetUsd: 1, hardCapUsd: 1.5, perAgentCapUsd: 100, shardCount: 2 });
    await t.reserve({ accountId: 'acct', agentId: 'ag', ceilingTier: 'high', estimateUsd: 1.0, reqType: 'streaming', resId: 'r1', shard: 0 });
    await t.commit('r1', 1.0);
    await t.reserve({ accountId: 'acct', agentId: 'ag', ceilingTier: 'high', estimateUsd: 0.8, reqType: 'streaming', resId: 'r2', shard: 1 });
    t.reconcile('acct');
    expect(t.getAccount('acct')!.headroomExhausted).toBe(true);
  });
});

// ───────────────────── Estimate function (§5.2 worst-case) ─────────────────────
describe('budget estimate — worst-case at the ceiling tier (ADR-204 §5.2)', () => {
  const cfg = loadConfig();
  it('prices prompt at Rate_In and maxTokens at Rate_Out of the CEILING tier', () => {
    const high = cfg.tierPools.high;
    const est = worstCaseEstimateUsd(cfg, 'high', 1_000_000, 1_000_000);
    expect(est).toBeCloseTo(high.rateInPer1M + high.rateOutPer1M, 6);
  });
  it('ceiling-tier estimate ≥ low-tier estimate for the same tokens (gates the §4.3 margin attack)', () => {
    expect(worstCaseEstimateUsd(cfg, 'high', 1000, 1000)).toBeGreaterThan(worstCaseEstimateUsd(cfg, 'low', 1000, 1000));
  });
  it('prompt floor is family-correct for the ceiling tier model', () => {
    const n = promptTokenFloor(cfg, 'high', [{ role: 'user', content: 'hello world' }]);
    expect(n).toBeGreaterThan(0);
  });
});

// ───────────────────── Request-path wiring (reserve→invoke→commit) ─────────────────────
describe('budget wiring — /v1/chat/completions reserve→invoke→commit (ADR-204 §5.2)', () => {
  it('unmetered key: request succeeds unchanged (budget layer transparent)', async () => {
    const app = createAppWith({ keyStore: keyStore() }); // default tracker, no seeded account
    const r = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', KEY)
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(200);
    expect(r.body.x_cognitum.resolved_tier).toBe('low');
  });

  it('metered account at/over cap: request is denied 402 BEFORE the provider invoke', async () => {
    const budget = new InMemoryBudgetTracker(loadConfig());
    budget.seedAccount('acct-1', { servingBudgetUsd: 0, hardCapUsd: 0, perAgentCapUsd: 0, shardCount: 4, headroomExhausted: true });
    const app = createAppWith({ keyStore: keyStore('acct-1'), budget });
    const r = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', KEY)
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('account_budget_exhausted');
  });

  it('metered happy path: a reservation is committed with the actual after the invoke', async () => {
    const budget = new InMemoryBudgetTracker(loadConfig());
    budget.seedAccount('acct-1', { servingBudgetUsd: 100, hardCapUsd: 100, perAgentCapUsd: 100, shardCount: 1 });
    const app = createAppWith({ keyStore: keyStore('acct-1'), budget });
    const r = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', KEY)
      .set('X-Cognitum-Agent-Id', 'agent-x')
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hi there' }] });
    expect(r.status).toBe(200);
    const reservation = budget.getReservation(r.headers['x-request-id']);
    expect(reservation).toBeDefined();
    expect(reservation!.state).toBe('committed');
    expect(reservation!.actualUsd).toBeCloseTo(r.body.x_cognitum.price_usd, 9);
    // The shard for agent-x holds the committed actual, no outstanding reservation.
    const shard = budget.getShard('acct-1', 'agent-x', reservation!.shard)!;
    expect(shard.reservedUsd).toBeCloseTo(0, 9);
    expect(shard.committedUsd).toBeCloseTo(r.body.x_cognitum.price_usd, 9);
  });
});
