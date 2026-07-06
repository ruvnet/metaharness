// @metaharness/flywheel — unit tests for the primitives (gate clauses, receipts, lineage, lift curve).
import { describe, it, expect } from 'vitest';
import {
  meetsPromotionRule, gateFingerprint, makeSigner, verifyReceipt, canon,
  InMemoryLineageStore, computeLiftCurve, verifyReplayBundle,
  type Score, type LineageCommit, type PromotionReceipt, type ReplayBundle,
} from '../src/index.js';

const S = (over: Partial<Score> = {}): Score => ({ primary: 5, noopRate: 0.3, costPerWin: 1, regressed: false, ...over });

describe('meetsPromotionRule — the frozen conjunctive gate', () => {
  it('promotes only when EVERY clause holds (primary↑ ∧ noop↓ ∧ cost≤ ∧ ¬regressed)', () => {
    expect(meetsPromotionRule({ baseline: S(), candidate: S({ primary: 6, noopRate: 0.2 }) }).promote).toBe(true);
  });
  it('blocks a primary regression', () => {
    expect(meetsPromotionRule({ baseline: S(), candidate: S({ primary: 4, noopRate: 0.2 }) }).reasons).toContain('primary_regressed');
  });
  it('blocks a gold-only gain with no no-op improvement (the cand-6 signal is load-bearing)', () => {
    const d = meetsPromotionRule({ baseline: S(), candidate: S({ primary: 9, noopRate: 0.3 }) });
    expect(d.promote).toBe(false);
    expect(d.reasons).toContain('noop_rate_not_improved');
  });
  it('blocks a cost regression and a safety regression', () => {
    expect(meetsPromotionRule({ baseline: S(), candidate: S({ primary: 6, noopRate: 0.2, costPerWin: 2 }) }).reasons).toContain('cost_per_win_worsened');
    expect(meetsPromotionRule({ baseline: S(), candidate: S({ primary: 6, noopRate: 0.2, regressed: true }) }).reasons).toContain('safety_regressed');
  });
  it('blocks an anchor regression when an anchor is supplied', () => {
    expect(meetsPromotionRule({ baseline: S(), candidate: S({ primary: 6, noopRate: 0.2 }), anchor: { baseline: 5, candidate: 4 } }).reasons).toContain('anchor_regressed');
  });
  it('gateFingerprint is stable + distinguishes a different rule', () => {
    expect(gateFingerprint(meetsPromotionRule)).toBe(gateFingerprint(meetsPromotionRule));
    expect(gateFingerprint(meetsPromotionRule)).not.toBe(gateFingerprint(() => ({ promote: true, reasons: [] })));
  });
});

describe('receipts — trust the signature, not the producer', () => {
  it('sign/verify round-trips; tampering fails; canon is deterministic', () => {
    const signer = makeSigner();
    const r = signer.sign({ b: 2, a: 1 });
    expect(verifyReceipt(r)).toBe(true);
    expect(verifyReceipt({ ...r, payload: { ...r.payload, a: 99 } } as PromotionReceipt)).toBe(false);
    expect(canon({ b: 2, a: 1 })).toBe('{"a":1,"b":2}'); // sorted keys
  });
});

describe('lineage + lift curve', () => {
  it('walkToRoot reconstructs current→root and computeLiftCurve accumulates primary', async () => {
    const store = new InMemoryLineageStore();
    const rec = makeSigner().sign({ k: 1 });
    const commit = (id: string, gen: number, parents: string[], verdict: LineageCommit['verdict'], delta: number): LineageCommit =>
      ({ id, generation: gen, parents, mutation: verdict === 'ROOT' ? null : { target: 't', summary: 's' }, primaryDelta: delta, anchorScore: 3, verdict, failureReasons: [], receipt: rec, createdAt: `g${gen}` });
    await store.append(commit('root', 0, [], 'ROOT', 0));
    await store.append(commit('g1', 1, ['root'], 'PROMOTED', 2));
    await store.append(commit('g2', 2, ['g1'], 'PROMOTED', 3));
    const chain = await store.walkToRoot('g2');
    expect(chain.map((c) => c.id)).toEqual(['g2', 'g1', 'root']);
    expect(chain[chain.length - 1]!.parents).toEqual([]);
    const curve = computeLiftCurve(chain, 5); // root primary 5
    expect(curve.map((p) => p.primary)).toEqual([5, 7, 10]); // 5 → +2 → +3
  });
});

describe('verifyReplayBundle — an HONEST-NULL run (0 promotions) is VALID (regression: ADR-235)', () => {
  const signer = makeSigner();
  const root: LineageCommit = {
    id: 'root', generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: null,
    verdict: 'ROOT', failureReasons: [], receipt: signer.sign({ kind: 'root', root: 'root' }), createdAt: 'gen-0',
  };
  const bundle: ReplayBundle = {
    data_source: 'LIVE', root_id: 'root', chain: [root], all_commits: [],
    lift_curve: [{ generation: 0, primary: 1, delta: 0, anchor: null }],
    gate_fingerprint: gateFingerprint(meetsPromotionRule),
    verified_improvements: 0, anchor_surviving_improvements: 0, milestone_reached: false, created_at: 'gen-0',
  };

  it('a root-only chain (the flywheel found no lift) PASSES replay — not an invalid bundle', () => {
    const v = verifyReplayBundle(bundle, { pinnedGateFingerprint: gateFingerprint(meetsPromotionRule) });
    expect(v.checks.allPromoted).toBe(true);   // vacuously true: no non-root commits to be un-promoted
    expect(v.checks.reachesRoot).toBe(true);
    expect(v.pass).toBe(true);
  });

  it('still REJECTS a chain with a smuggled non-PROMOTED commit', () => {
    const rejected: LineageCommit = { ...root, id: 'c1', generation: 1, parents: ['root'], verdict: 'REJECTED', mutation: { target: 'x', summary: 'x' } };
    const bad: ReplayBundle = { ...bundle, chain: [rejected, root] };
    expect(verifyReplayBundle(bad).checks.allPromoted).toBe(false);
  });
});
