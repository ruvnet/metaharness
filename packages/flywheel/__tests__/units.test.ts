// @metaharness/flywheel — unit tests for the primitives (gate clauses, receipts, lineage, lift curve).
import { describe, it, expect } from 'vitest';
import {
  meetsPromotionRule, gateFingerprint, makeSigner, verifyReceipt, canon,
  InMemoryLineageStore, computeLiftCurve, verifyReplayBundle,
  analyzeBundle, formatAnalysis,
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

describe('verifyReplayBundle — gateReExecutes: re-run the rule on sealed scores (ADR-235)', () => {
  const signer = makeSigner();
  const S2 = (o: Partial<Score> = {}): Score => ({ primary: 5, noopRate: 0.3, costPerWin: 1, regressed: false, ...o });
  const root: LineageCommit = {
    id: 'root', generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: null,
    verdict: 'ROOT', failureReasons: [], receipt: signer.sign({ kind: 'root', root: 'root' }), createdAt: 'g0',
  };
  const promoted = (baselineScore: Score, candidateScore: Score): LineageCommit => ({
    id: 'c1', generation: 1, parents: ['root'], mutation: { target: 't', summary: 'adapt t' }, primaryDelta: 1,
    anchorScore: null, verdict: 'PROMOTED', failureReasons: [], receipt: signer.sign({ kind: 'candidate', id: 'c1' }),
    createdAt: 'g1', baselineScore, candidateScore,
  });
  const bundleOf = (c1: LineageCommit): ReplayBundle => ({
    data_source: 'SYNTHETIC', root_id: 'root', chain: [c1, root], all_commits: [c1],
    lift_curve: [], gate_fingerprint: gateFingerprint(meetsPromotionRule),
    verified_improvements: 1, anchor_surviving_improvements: 1, milestone_reached: false, created_at: 'g1',
  });

  it('a PROMOTED commit whose sealed scores RE-PASS the rule → gateReExecutes true, pass', () => {
    const b = bundleOf(promoted(S2(), S2({ primary: 6, noopRate: 0.2 })));
    const v = verifyReplayBundle(b, { pinnedGateFingerprint: gateFingerprint(meetsPromotionRule), promotionRule: meetsPromotionRule });
    expect(v.checks.gateReExecutes).toBe(true);
    expect(v.pass).toBe(true);
  });

  it('a FORGED promotion (verdict PROMOTED but scores the rule would REJECT) → gateReExecutes false', () => {
    const b = bundleOf(promoted(S2(), S2({ primary: 4, noopRate: 0.2 }))); // primary regressed → rule.promote=false
    const v = verifyReplayBundle(b, { promotionRule: meetsPromotionRule });
    expect(v.checks.gateReExecutes).toBe(false);
    expect(v.pass).toBe(false);
  });

  it('a WRONG (fingerprint-mismatched) rule → gateReExecutes false', () => {
    const b = bundleOf(promoted(S2(), S2({ primary: 6, noopRate: 0.2 })));
    const otherRule = () => ({ promote: true, reasons: [] as string[] }); // different source ⇒ different fingerprint
    expect(verifyReplayBundle(b, { promotionRule: otherRule }).checks.gateReExecutes).toBe(false);
  });

  it('backward-compatible: NO rule supplied ⇒ gateReExecutes unchecked (true)', () => {
    const b = bundleOf(promoted(S2(), S2({ primary: 6, noopRate: 0.2 })));
    expect(verifyReplayBundle(b, { pinnedGateFingerprint: gateFingerprint(meetsPromotionRule) }).checks.gateReExecutes).toBe(true);
  });
});

describe('analyzeBundle — F-P2 mutation-effectiveness', () => {
  const mk = (target: string, gen: number, verdict: 'PROMOTED' | 'REJECTED', primaryDelta: number, failureReasons: string[] = []): LineageCommit =>
    ({ id: `${target}-${gen}`, generation: gen, parents: [], mutation: { target, summary: '' }, primaryDelta, anchorScore: null, verdict, failureReasons } as LineageCommit);
  const bundle = (all: LineageCommit[]): ReplayBundle =>
    ({ data_source: 'SYNTHETIC', root_id: 'root', chain: [], all_commits: all, lift_curve: [], gate_fingerprint: null, verified_improvements: 0, anchor_surviving_improvements: 0, milestone_reached: false, created_at: 'x' } as ReplayBundle);

  it('ranks the most-promoted lever first + computes per-lever rate, avg lift, anchor-regressions', () => {
    const a = analyzeBundle(bundle([
      mk('edit', 1, 'PROMOTED', 2), mk('edit', 2, 'PROMOTED', 3),           // edit: 2/2 promoted, avgΔ 2.5
      mk('escalate', 1, 'REJECTED', 0), mk('escalate', 2, 'REJECTED', -1, ['anchor_regressed']),
      mk('verify', 3, 'PROMOTED', 1),                                        // verify: 1/1 promoted
    ]));
    expect(a.candidates).toBe(5);
    expect(a.promotions).toBe(3);
    expect(a.rejections).toBe(2);
    expect(a.anchorRegressed).toBe(1);
    expect(a.byTarget[0]!.target).toBe('edit');            // most promotions ranks first
    expect(a.byTarget[0]!.promoteRate).toBe(1);
    expect(a.byTarget[0]!.avgDeltaPromoted).toBeCloseTo(2.5);
    const escalate = a.byTarget.find((t) => t.target === 'escalate')!;
    expect(escalate.promotions).toBe(0);
    expect(escalate.rejections).toBe(2);
  });

  it('an honest-null (no candidates) analyzes cleanly + formats without throwing', () => {
    const a = analyzeBundle(bundle([]));
    expect(a.candidates).toBe(0);
    expect(a.byTarget).toEqual([]);
    const lines = formatAnalysis(a, 'null-run');
    expect(lines.join('\n')).toContain('honest-null');
  });
});
