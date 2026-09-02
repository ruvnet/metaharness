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

describe('verifyReplayBundle — gateReExecutes: re-run the rule on sealed scores (ADR-235, extended ADR-254)', () => {
  const signer = makeSigner();
  const S2 = (o: Partial<Score> = {}): Score => ({ primary: 5, noopRate: 0.3, costPerWin: 1, regressed: false, ...o });
  const root: LineageCommit = {
    id: 'root', generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: null,
    verdict: 'ROOT', failureReasons: [], receipt: signer.sign({ kind: 'root', root: 'root' }), createdAt: 'g0',
  };
  const promoted = (baselineScore: Score, candidateScore: Score): LineageCommit => ({
    id: 'c1', generation: 1, parents: ['root'], mutation: { target: 't', summary: 'adapt t' }, primaryDelta: 1,
    anchorScore: null, verdict: 'PROMOTED', failureReasons: [], receipt: signer.sign({ kind: 'candidate', id: 'c1', verdict: 'PROMOTED' }),
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

  // [gap disclosed 2026-08-16 #205, closed 2026-08-26 #231] gateReExecutes previously NEVER supplied
  // PromotionEvidence.anchor, so a promotion that regressed the frozen anti-Goodhart anchor replayed
  // clean. The root's sealed anchorScore is now the re-check's baseline bar.
  it('an ANCHOR-REGRESSED promotion (root.anchorScore=5, commit.anchorScore=4) → gateReExecutes false', () => {
    const anchoredRoot: LineageCommit = { ...root, anchorScore: 5 };
    const c1 = { ...promoted(S2(), S2({ primary: 6, noopRate: 0.2 })), anchorScore: 4 }; // below root anchor
    const b: ReplayBundle = { ...bundleOf(c1), chain: [c1, anchoredRoot], all_commits: [c1] };
    const v = verifyReplayBundle(b, { promotionRule: meetsPromotionRule });
    expect(v.checks.gateReExecutes).toBe(false);
    expect(v.pass).toBe(false);
  });

  it('an anchor-SURVIVING promotion (root.anchorScore=5, commit.anchorScore=6) → gateReExecutes still true', () => {
    const anchoredRoot: LineageCommit = { ...root, anchorScore: 5 };
    const c1 = { ...promoted(S2(), S2({ primary: 6, noopRate: 0.2 })), anchorScore: 6 }; // meets/exceeds root anchor
    const b: ReplayBundle = { ...bundleOf(c1), chain: [c1, anchoredRoot], all_commits: [c1] };
    const v = verifyReplayBundle(b, { promotionRule: meetsPromotionRule });
    expect(v.checks.gateReExecutes).toBe(true);
    expect(v.pass).toBe(true);
  });

  it('anchor EQUALS root exactly (boundary: candidate=baseline) → not a regression, gateReExecutes true', () => {
    const anchoredRoot: LineageCommit = { ...root, anchorScore: 5 };
    const c1 = { ...promoted(S2(), S2({ primary: 6, noopRate: 0.2 })), anchorScore: 5 }; // == root anchor
    const b: ReplayBundle = { ...bundleOf(c1), chain: [c1, anchoredRoot], all_commits: [c1] };
    const v = verifyReplayBundle(b, { promotionRule: meetsPromotionRule });
    expect(v.checks.gateReExecutes).toBe(true);
    expect(v.pass).toBe(true);
  });

  it('no anchor suite used (root.anchorScore=null) → anchor clause stays unchecked, unaffected', () => {
    const b = bundleOf(promoted(S2(), S2({ primary: 6, noopRate: 0.2 }))); // default root has anchorScore: null
    const v = verifyReplayBundle(b, { promotionRule: meetsPromotionRule });
    expect(v.checks.gateReExecutes).toBe(true);
    expect(v.pass).toBe(true);
  });

  // [fail-closed fix, review verdict on #231] missing required gate evidence must FAIL replay, not be
  // silently treated as "unchecked" — mutation tests: delete each field from an otherwise-valid,
  // gate-re-passing bundle and require pass === false.
  it('mutation: PROMOTED commit missing baselineScore → gateReExecutes false, pass false', () => {
    const c1: LineageCommit = { ...promoted(S2(), S2({ primary: 6, noopRate: 0.2 })), baselineScore: undefined };
    const b = bundleOf(c1);
    const v = verifyReplayBundle(b, { promotionRule: meetsPromotionRule });
    expect(v.checks.gateReExecutes).toBe(false);
    expect(v.pass).toBe(false);
  });

  it('mutation: PROMOTED commit missing candidateScore → gateReExecutes false, pass false', () => {
    const c1: LineageCommit = { ...promoted(S2(), S2({ primary: 6, noopRate: 0.2 })), candidateScore: undefined };
    const b = bundleOf(c1);
    const v = verifyReplayBundle(b, { promotionRule: meetsPromotionRule });
    expect(v.checks.gateReExecutes).toBe(false);
    expect(v.pass).toBe(false);
  });

  it('mutation: root pins an anchor but the PROMOTED commit is missing its anchorScore → gateReExecutes false, pass false', () => {
    const anchoredRoot: LineageCommit = { ...root, anchorScore: 5 };
    const c1 = { ...promoted(S2(), S2({ primary: 6, noopRate: 0.2 })), anchorScore: null }; // deleted
    const b: ReplayBundle = { ...bundleOf(c1), chain: [c1, anchoredRoot], all_commits: [c1] };
    const v = verifyReplayBundle(b, { promotionRule: meetsPromotionRule });
    expect(v.checks.gateReExecutes).toBe(false);
    expect(v.pass).toBe(false);
  });

  // [private-triage follow-up on #231] `baselineScore != null` / `candidateScore != null` only proves the
  // Score OBJECT exists — an untrusted bundle can carry one with a missing/mistyped field. Because
  // meetsPromotionRule compares with `<`/`>` on possibly-undefined values, JS comparison semantics make
  // several clauses fail OPEN (`undefined > n` is false ⇒ cost_per_win_worsened never fires; a missing
  // `regressed` is falsy ⇒ safety_regressed never fires). Mutation-test EVERY required Score field, on
  // both baseline and candidate, deleted from an otherwise gate-repassing bundle: pass must be false.
  describe('mutation: an otherwise gate-repassing bundle with one Score field deleted → gateReExecutes false, pass false', () => {
    const fields: (keyof Score)[] = ['primary', 'noopRate', 'costPerWin', 'regressed'];
    for (const side of ['baselineScore', 'candidateScore'] as const) {
      for (const field of fields) {
        it(`${side}.${field} deleted`, () => {
          const good = S2({ primary: 6, noopRate: 0.2 });
          const base = side === 'baselineScore' ? { ...S2(), [field]: undefined } : S2();
          const cand = side === 'candidateScore' ? { ...good, [field]: undefined } : good;
          const c1 = promoted(base as Score, cand as Score);
          const v = verifyReplayBundle(bundleOf(c1), { promotionRule: meetsPromotionRule });
          expect(v.checks.gateReExecutes).toBe(false);
          expect(v.pass).toBe(false);
        });
      }
    }
  });
});

describe('verifyReplayBundle — all_commits receipts (the full diagnostic ledger, not just the winning chain)', () => {
  const signer = makeSigner();
  const root: LineageCommit = {
    id: 'root', generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: null,
    verdict: 'ROOT', failureReasons: [], receipt: signer.sign({ kind: 'root', root: 'root' }), createdAt: 'g0',
  };
  const rejected: LineageCommit = {
    id: 'c1', generation: 1, parents: ['root'], mutation: { target: 'x', summary: 'adapt x' }, primaryDelta: -1,
    anchorScore: null, verdict: 'REJECTED', failureReasons: ['primary_regressed'],
    receipt: signer.sign({ kind: 'candidate', id: 'c1', verdict: 'REJECTED' }), createdAt: 'g1',
  };
  const honestNullBundle: ReplayBundle = {
    data_source: 'SYNTHETIC', root_id: 'root', chain: [root], all_commits: [rejected],
    lift_curve: [], gate_fingerprint: gateFingerprint(meetsPromotionRule),
    verified_improvements: 0, anchor_surviving_improvements: 0, milestone_reached: false, created_at: 'g1',
  };

  it('a genuinely-signed all_commits entry PASSES (regression pin)', () => {
    const v = verifyReplayBundle(honestNullBundle, { pinnedGateFingerprint: gateFingerprint(meetsPromotionRule) });
    expect(v.checks.allCommitsReceipts).toBe(true);
    expect(v.pass).toBe(true);
  });

  it('a TAMPERED all_commits receipt (forged primaryDelta inside the signed payload) is caught even though chain alone verifies', () => {
    const tampered: LineageCommit = {
      ...rejected,
      primaryDelta: 3, // claim a POSITIVE effect for what the signed receipt says was a rejection...
      receipt: { ...rejected.receipt, payload: { ...rejected.receipt.payload, primaryDelta: 3 } }, // ...payload edited, signature NOT re-signed
    };
    const bad: ReplayBundle = { ...honestNullBundle, all_commits: [tampered] };
    const v = verifyReplayBundle(bad, { pinnedGateFingerprint: gateFingerprint(meetsPromotionRule) });
    // the promoted chain (just the root) still verifies fine — proving this check, not `receipts`, caught it
    expect(v.checks.receipts).toBe(true);
    expect(v.checks.allCommitsReceipts).toBe(false);
    expect(v.pass).toBe(false);
    expect(v.failures).toContain('allCommitsReceipts');
  });

  it('a VERDICT-FLIP (outer verdict changed to PROMOTED, signature/payload left untouched) is caught — a valid signature is not proof it is attached to the right claim', () => {
    // the receipt is byte-for-byte the honestly-signed REJECTED receipt — verifyReceipt(receipt) alone
    // would say "valid" — but the commit's own `verdict` field now claims PROMOTED. Splicing an
    // unmodified-but-mismatched receipt like this is exactly what a signature-only check cannot catch.
    const flipped: LineageCommit = { ...rejected, verdict: 'PROMOTED', failureReasons: [] };
    const bad: ReplayBundle = { ...honestNullBundle, all_commits: [flipped] };
    const v = verifyReplayBundle(bad, { pinnedGateFingerprint: gateFingerprint(meetsPromotionRule) });
    expect(v.checks.allCommitsReceipts).toBe(false);
    expect(v.pass).toBe(false);
  });
});

describe('verifyReplayBundle — gateReExecutes: a PROMOTED commit missing sealed scores must FAIL, not skip', () => {
  const signer = makeSigner();
  const root: LineageCommit = {
    id: 'root', generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: null,
    verdict: 'ROOT', failureReasons: [], receipt: signer.sign({ kind: 'root', root: 'root' }), createdAt: 'g0',
  };
  // A PROMOTED commit with NO baselineScore/candidateScore — e.g. a forged bundle, or a legacy producer
  // that never sealed them. Nothing here is internally inconsistent; it just cannot be re-gated.
  const unauditablePromotion: LineageCommit = {
    id: 'c1', generation: 1, parents: ['root'], mutation: { target: 't', summary: 'adapt t' }, primaryDelta: 5,
    anchorScore: null, verdict: 'PROMOTED', failureReasons: [],
    receipt: signer.sign({ kind: 'candidate', id: 'c1', verdict: 'PROMOTED' }), createdAt: 'g1',
    // baselineScore / candidateScore deliberately omitted
  };
  const bundle: ReplayBundle = {
    data_source: 'SYNTHETIC', root_id: 'root', chain: [unauditablePromotion, root], all_commits: [unauditablePromotion],
    lift_curve: [], gate_fingerprint: gateFingerprint(meetsPromotionRule),
    verified_improvements: 1, anchor_surviving_improvements: 0, milestone_reached: false, created_at: 'g1',
  };

  it('gateReExecutes is FALSE when a rule is supplied and a PROMOTED commit has no sealed scores to check', () => {
    const v = verifyReplayBundle(bundle, { promotionRule: meetsPromotionRule });
    expect(v.checks.gateReExecutes).toBe(false);
    expect(v.pass).toBe(false);
  });

  it('unchecked (true) when NO rule is supplied — unaffected, matches existing backward-compat contract', () => {
    const v = verifyReplayBundle(bundle, { pinnedGateFingerprint: gateFingerprint(meetsPromotionRule) });
    expect(v.checks.gateReExecutes).toBe(true);
  });
});

describe('verifyReplayBundle — sealedFieldsAuthentic: signed scores must match the live commit', () => {
  const signer = makeSigner();
  const root: LineageCommit = {
    id: 'root', generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: null,
    verdict: 'ROOT', failureReasons: [], receipt: signer.sign({ kind: 'root', root: 'root' }), createdAt: 'g0',
  };
  const bundleOf = (c1: LineageCommit): ReplayBundle => ({
    data_source: 'SYNTHETIC', root_id: 'root', chain: [c1, root], all_commits: [c1],
    lift_curve: [], gate_fingerprint: gateFingerprint(meetsPromotionRule),
    verified_improvements: 1, anchor_surviving_improvements: 1, milestone_reached: false, created_at: 'g1',
  });

  it('a NEW-format receipt (sealed fields in the signed payload) matching the live commit passes', () => {
    const baselineScore = S({ primary: 5 });
    const candidateScore = S({ primary: 6, noopRate: 0.2 });
    const c1: LineageCommit = {
      id: 'c1', generation: 1, parents: ['root'], mutation: { target: 't', summary: 'adapt t' }, primaryDelta: 1,
      anchorScore: null, verdict: 'PROMOTED', failureReasons: [],
      receipt: signer.sign({ kind: 'candidate', id: 'c1', target: 't', verdict: 'PROMOTED', primaryDelta: 1, baselineScore, candidateScore, anchorScore: null, failureReasons: [] }),
      createdAt: 'g1', baselineScore, candidateScore,
    };
    const v = verifyReplayBundle(bundleOf(c1));
    expect(v.checks.sealedFieldsAuthentic).toBe(true);
    expect(v.pass).toBe(true);
  });

  it('tampering with an unsigned score AFTER signing (no signing key needed) fails sealedFieldsAuthentic', () => {
    const baselineScore = S({ primary: 5 });
    const candidateScore = S({ primary: 6, noopRate: 0.2 });
    const c1: LineageCommit = {
      id: 'c1', generation: 1, parents: ['root'], mutation: { target: 't', summary: 'adapt t' }, primaryDelta: 1,
      anchorScore: null, verdict: 'PROMOTED', failureReasons: [],
      receipt: signer.sign({ kind: 'candidate', id: 'c1', target: 't', verdict: 'PROMOTED', primaryDelta: 1, baselineScore, candidateScore, anchorScore: null, failureReasons: [] }),
      createdAt: 'g1', baselineScore,
      candidateScore: S({ primary: 99, noopRate: 0 }), // ← spliced post-signing; receipt itself still verifies
    };
    expect(verifyReceipt(c1.receipt)).toBe(true); // the signature alone can't catch this — that's the gap
    const v = verifyReplayBundle(bundleOf(c1));
    expect(v.checks.sealedFieldsAuthentic).toBe(false);
    expect(v.pass).toBe(false);
  });

  it('backward-compatible: an OLD-format receipt (no sealed keys in the payload) is unchecked (true)', () => {
    const baselineScore = S({ primary: 5 });
    const candidateScore = S({ primary: 6, noopRate: 0.2 });
    const c1: LineageCommit = {
      id: 'c1', generation: 1, parents: ['root'], mutation: { target: 't', summary: 'adapt t' }, primaryDelta: 1,
      anchorScore: null, verdict: 'PROMOTED', failureReasons: [],
      receipt: signer.sign({ kind: 'candidate', id: 'c1' }), // pre-fix payload shape (see ADR-235 tests above)
      createdAt: 'g1', baselineScore, candidateScore,
    };
    expect(verifyReplayBundle(bundleOf(c1)).checks.sealedFieldsAuthentic).toBe(true);
  });

  it('cloning ONE genuine receipt onto a fabricated commit id (no signing key needed) fails — the receipt must be BOUND to the commit it decorates, not just internally consistent', () => {
    const baselineScore = S({ primary: 5 });
    const candidateScore = S({ primary: 6, noopRate: 0.2 });
    // The one real, legitimately-signed promotion.
    const genuineReceipt = signer.sign({ kind: 'candidate', id: 'c1', target: 't', verdict: 'PROMOTED', primaryDelta: 1, baselineScore, candidateScore, anchorScore: null, failureReasons: [] });
    const genuine: LineageCommit = {
      id: 'c1', generation: 1, parents: ['root'], mutation: { target: 't', summary: 'adapt t' }, primaryDelta: 1,
      anchorScore: null, verdict: 'PROMOTED', failureReasons: [], receipt: genuineReceipt, createdAt: 'g1', baselineScore, candidateScore,
    };
    // An attacker with NO signing key clones that same receipt onto a second, fabricated commit id,
    // copying the genuine scores onto its live fields too — so a naive "do the sealed values match"
    // check alone would pass it. This manufactures a 2-generation promoted lineage from one real
    // promotion; verifyReceipt still reports true for the cloned receipt (it's a genuine signature).
    const forged: LineageCommit = {
      id: 'c2-forged', generation: 2, parents: ['c1'], mutation: { target: 't', summary: 'adapt t' }, primaryDelta: 1,
      anchorScore: null, verdict: 'PROMOTED', failureReasons: [], receipt: genuineReceipt, createdAt: 'g2', baselineScore, candidateScore,
    };
    expect(verifyReceipt(forged.receipt)).toBe(true); // the clone's signature verifies fine — that's the point
    const bundle: ReplayBundle = {
      data_source: 'SYNTHETIC', root_id: 'root', chain: [forged, genuine, root], all_commits: [forged, genuine],
      lift_curve: [], gate_fingerprint: gateFingerprint(meetsPromotionRule),
      verified_improvements: 2, anchor_surviving_improvements: 2, milestone_reached: true, created_at: 'g2',
    };
    const v = verifyReplayBundle(bundle);
    expect(v.checks.sealedFieldsAuthentic).toBe(false); // forged.receipt.payload.id ('c1') != forged.id ('c2-forged')
    expect(v.pass).toBe(false);
  });

  it('splicing TWO genuinely (separately) signed commits into a fabricated chain via unsigned parents/generation fails — each receipt is individually valid, but the CHAIN SHAPE was never signed', () => {
    // Two real, independently-signed PROMOTED commits — neither is a clone of the other, each is
    // correctly bound to its own id/scores. `a1`'s true parent is 'root'; `b1`'s true parent is some
    // OTHER root the attacker doesn't have (simulating a commit lifted from a different run/lineage).
    const aBaseline = S({ primary: 5 });
    const aCandidate = S({ primary: 6, noopRate: 0.2 });
    const aReceipt = signer.sign({ kind: 'candidate', id: 'a1', target: 't', verdict: 'PROMOTED', primaryDelta: 1, baselineScore: aBaseline, candidateScore: aCandidate, anchorScore: null, failureReasons: [], parents: ['root'], generation: 1 });
    const a1: LineageCommit = {
      id: 'a1', generation: 1, parents: ['root'], mutation: { target: 't', summary: 'adapt t' }, primaryDelta: 1,
      anchorScore: null, verdict: 'PROMOTED', failureReasons: [], receipt: aReceipt, createdAt: 'g1', baselineScore: aBaseline, candidateScore: aCandidate,
    };
    const bBaseline = S({ primary: 7 });
    const bCandidate = S({ primary: 8, noopRate: 0.1 });
    const bReceipt = signer.sign({ kind: 'candidate', id: 'b1', target: 'u', verdict: 'PROMOTED', primaryDelta: 1, baselineScore: bBaseline, candidateScore: bCandidate, anchorScore: null, failureReasons: [], parents: ['root-elsewhere'], generation: 1 });
    // An attacker with NO signing key rewrites ONLY b1's unsigned `parents`/`generation` to splice it
    // onto a1's chain (b1's own id/scores/receipt are left genuinely intact — id binding alone would NOT
    // catch this, since b1 is still honestly bound to itself).
    const bSpliced: LineageCommit = {
      id: 'b1', generation: 2, parents: ['a1'], mutation: { target: 'u', summary: 'adapt u' }, primaryDelta: 1,
      anchorScore: null, verdict: 'PROMOTED', failureReasons: [], receipt: bReceipt, createdAt: 'g2', baselineScore: bBaseline, candidateScore: bCandidate,
    };
    expect(verifyReceipt(bSpliced.receipt)).toBe(true); // b1's own signature is genuinely valid
    const bundle: ReplayBundle = {
      data_source: 'SYNTHETIC', root_id: 'root', chain: [bSpliced, a1, root], all_commits: [bSpliced, a1],
      lift_curve: [], gate_fingerprint: gateFingerprint(meetsPromotionRule),
      verified_improvements: 2, anchor_surviving_improvements: 2, milestone_reached: true, created_at: 'g2',
    };
    // Structurally the spliced chain looks perfectly fine (contiguous, reaches root) — only the sealed
    // parents/generation binding reveals b1 was never actually a child of a1.
    expect(verifyReplayBundle(bundle).checks.contiguousParents).toBe(true);
    const v = verifyReplayBundle(bundle);
    expect(v.checks.sealedFieldsAuthentic).toBe(false); // bSpliced.receipt.payload.parents (['root-elsewhere']) != live parents (['a1'])
    expect(v.pass).toBe(false);
  });
});

describe('analyzeBundle — F-P2 mutation-effectiveness', () => {
  const mk = (target: string, gen: number, verdict: 'PROMOTED' | 'REJECTED', primaryDelta: number, failureReasons: string[] = [], costPerWin = 1): LineageCommit =>
    ({ id: `${target}-${gen}`, generation: gen, parents: [], mutation: { target, summary: '' }, primaryDelta, anchorScore: null, verdict, failureReasons, candidateScore: { primary: 0, noopRate: 0, costPerWin, regressed: false } } as LineageCommit);
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
    expect(a.byTarget[0]!.avgCostPerWinPromoted).toBeCloseTo(1); // edit's promoted candidates each cost 1/win
    expect(a.byTarget[0]!.bestCostPerWin).toBe(1);
    const escalate = a.byTarget.find((t) => t.target === 'escalate')!;
    expect(escalate.promotions).toBe(0);
    expect(escalate.rejections).toBe(2);
  });

  it('cost-per-win trajectory follows the promoted chain root→current + flags the direction', () => {
    // chain is stored current→root; wins get cheaper toward the root's original 3 → 2 → 1
    const chain = [mk('t', 2, 'PROMOTED', 1, [], 1), mk('t', 1, 'PROMOTED', 1, [], 2), mk('root', 0, 'PROMOTED', 0, [], 3)];
    const b = { ...bundle([]), chain };
    const a = analyzeBundle(b);
    expect(a.costPerWinTrend).toEqual([3, 2, 1]);                 // root→current
    expect(formatAnalysis(a, 'trend').join('\n')).toContain('cheaper ↓');
  });

  it('an honest-null (no candidates) analyzes cleanly + formats without throwing', () => {
    const a = analyzeBundle(bundle([]));
    expect(a.candidates).toBe(0);
    expect(a.byTarget).toEqual([]);
    const lines = formatAnalysis(a, 'null-run');
    expect(lines.join('\n')).toContain('honest-null');
  });
});
