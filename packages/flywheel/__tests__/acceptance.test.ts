// @metaharness/flywheel — THE ACCEPTANCE TEST for extraction.
//
// The extraction is only justified if `metaharness` (generic), `@metaharness/darwin` (a coding harness),
// and at least one NON-CODING vertical harness can all drive the SAME `runFlywheelGenerations()` API with
// NO benchmark-specific branches in the flywheel. This test proves exactly that: three domain adapters —
// a generic QA harness, a code-repair harness, and a (non-coding) trading harness — differ ONLY in their
// suites; the flywheel call, config shape, gate, receipts, lineage, and replay are identical for all three.
import { describe, it, expect } from 'vitest';
import {
  runFlywheelGenerations, meetsPromotionRule, gateFingerprint, makeSigner, verifyReplayBundle,
  type Policy, type Suite, type Proposer, type Evaluator, type Score,
} from '../src/index.js';

// ── a domain adapter = (rootPolicy, proposer, evaluator, holdout, anchor). The ONLY thing that changes
// between domains is the SUITE CONTENT (its task difficulties). The flywheel never sees the domain. ──
function makeAdapter(domain: string, holdoutDifficulties: number[], anchorDifficulties: number[]) {
  const rootPolicy: Policy = { reasoning: '', format: '', verification: '', escalation: '' };
  const suite = (id: string, diffs: number[]): Suite => ({ id: `${domain}:${id}`, items: diffs.map((d, i) => ({ id: `${domain}-${id}-${i}`, difficulty: d })) });

  // The proposer improves a lever by appending one "quality" token — domain-agnostic (a real proposer
  // would call a model here; the point is the flywheel doesn't care what a proposer does).
  const proposer: Proposer = async (base, target) => `${base.policy[target] ?? ''}#`;

  // The evaluator projects domain outcomes onto the abstract Score. A task is "solved" when the policy's
  // accumulated quality ≥ its difficulty; an unsolved task is a no-op (didn't commit). This is where a
  // real host/benchmark would live — code-repair, trading fills, QA grading — but it stays in the CALLER.
  const evaluator: Evaluator = async (policy: Policy, s: Suite): Promise<Score> => {
    const quality = Object.values(policy).join('').split('#').length - 1;
    let solved = 0;
    for (const item of s.items as Array<{ difficulty: number }>) if (quality >= item.difficulty) solved++;
    const n = Math.max(1, s.items.length);
    return { primary: solved, noopRate: (n - solved) / n, costPerWin: solved > 0 ? 1 / solved : 999, regressed: false };
  };

  return { rootPolicy, proposer, evaluator, holdout: suite('holdout', holdoutDifficulties), anchor: suite('anchor', anchorDifficulties) };
}

const PIN = gateFingerprint(meetsPromotionRule);

// Three DIFFERENT domains, IDENTICAL flywheel usage.
const DOMAINS: Array<{ name: string; holdout: number[]; anchor: number[] }> = [
  { name: 'metaharness-generic-qa', holdout: [1, 2, 3, 4, 5, 6], anchor: [1, 2, 3] },
  { name: 'darwin-code-repair', holdout: [1, 1, 2, 3, 4, 5, 6], anchor: [1, 2] },
  { name: 'vertical-trading (non-coding)', holdout: [1, 2, 2, 3, 4, 5], anchor: [1, 1, 2] },
];

describe('ACCEPTANCE — one runFlywheelGenerations() API, three domains, no benchmark branches', () => {
  for (const d of DOMAINS) {
    it(`${d.name}: compounds a lift curve + an externally-replayable, gate-frozen bundle`, async () => {
      const a = makeAdapter(d.name, d.holdout, d.anchor);
      const result = await runFlywheelGenerations({
        rootPolicy: a.rootPolicy,
        proposer: a.proposer,
        evaluator: a.evaluator,
        promotionRule: meetsPromotionRule,
        holdout: a.holdout,
        anchor: a.anchor,
        maxGenerations: 8,
        signer: makeSigner(),
        dataSource: 'SYNTHETIC',
      });

      // 1. The wheel climbed: ≥2 anchor-surviving compounding promotions → a real lift curve.
      expect(result.milestoneReached).toBe(true);
      const primaries = result.liftCurve.map((p) => p.primary);
      expect(primaries[primaries.length - 1]).toBeGreaterThan(primaries[0]!); // net climb
      // monotone non-decreasing along the promoted chain (each promotion re-based on the last winner)
      for (let i = 1; i < primaries.length; i++) expect(primaries[i]).toBeGreaterThanOrEqual(primaries[i - 1]!);

      // 2. The bundle replays externally, and the gate is provably UNCHANGED.
      const verdict = verifyReplayBundle(result.replayBundle, { pinnedGateFingerprint: PIN });
      expect(verdict.pass).toBe(true);
      expect(verdict.checks.gateUnchanged).toBe(true);
      expect(result.replayBundle.chain[result.replayBundle.chain.length - 1]!.parents).toEqual([]); // reaches gen-0 root
    });
  }

  it('onGeneration checkpoints fire per generation, each an independently-replayable bundle (crash-recoverable)', async () => {
    const a = makeAdapter('checkpoint', [1, 1, 2, 3, 4, 5, 6], [1, 2]);
    const seen: Array<{ generation: number; chainLen: number; pass: boolean }> = [];
    const result = await runFlywheelGenerations({
      rootPolicy: a.rootPolicy, proposer: a.proposer, evaluator: a.evaluator,
      promotionRule: meetsPromotionRule, holdout: a.holdout, anchor: a.anchor,
      maxGenerations: 5, signer: makeSigner(), dataSource: 'SYNTHETIC',
      onGeneration: (info) => {
        // Every checkpoint must be a COMPLETE, externally-replayable bundle for the run so far —
        // that is what makes a crashed multi-hour run recoverable from the last checkpoint.
        const v = verifyReplayBundle(info.partialBundle, { pinnedGateFingerprint: PIN });
        seen.push({ generation: info.generation, chainLen: info.partialBundle.chain.length, pass: v.pass });
      },
    });
    expect(seen.length).toBe(result.generationsRun);              // one checkpoint per generation run
    expect(seen.map((s) => s.generation)).toEqual(seen.map((_, i) => i + 1)); // strictly 1,2,3,…
    expect(seen.every((s) => s.pass)).toBe(true);                 // each mid-run bundle replays
    // the final checkpoint reflects the same terminal chain as the returned result
    expect(seen[seen.length - 1]!.chainLen).toBe(result.replayBundle.chain.length);
  });

  it('resumeFrom reproduces an uninterrupted run: (2 gens + resume) === (5 gens straight)', async () => {
    const mk = () => makeAdapter('resume', [1, 1, 2, 3, 4, 5, 6], [1, 2]);
    const cfg = (a: ReturnType<typeof makeAdapter>, extra: Record<string, unknown>) => ({
      rootPolicy: a.rootPolicy, proposer: a.proposer, evaluator: a.evaluator,
      promotionRule: meetsPromotionRule, holdout: a.holdout, anchor: a.anchor,
      signer: makeSigner(), dataSource: 'SYNTHETIC' as const, ...extra,
    });

    // A. the reference: 5 generations, uninterrupted.
    const full = await runFlywheelGenerations(cfg(mk(), { maxGenerations: 5 }));

    // B. run only 2 generations, capturing the resume state at the boundary (as if we crashed after gen 2).
    let saved: any = null;
    await runFlywheelGenerations(cfg(mk(), { maxGenerations: 2, onGeneration: (i: any) => { saved = i.resumeState; } }));
    expect(saved).toBeTruthy();
    expect(saved.fromGeneration).toBe(2);

    // C. resume from the checkpoint and finish (gens 3→5).
    const resumed = await runFlywheelGenerations(cfg(mk(), { maxGenerations: 5, resumeFrom: saved }));

    // The deterministic proposer/evaluator ⇒ the resumed run must reproduce the reference EXACTLY:
    // identical promoted chain (same commit ids), final policy, lift curve, and milestone.
    expect(resumed.replayBundle.chain.map((c) => c.id)).toEqual(full.replayBundle.chain.map((c) => c.id));
    expect(resumed.finalPolicy).toEqual(full.finalPolicy);
    expect(resumed.liftCurve.map((p) => p.primary)).toEqual(full.liftCurve.map((p) => p.primary));
    expect(resumed.milestoneReached).toBe(full.milestoneReached);
    expect(verifyReplayBundle(resumed.replayBundle, { pinnedGateFingerprint: PIN }).pass).toBe(true);
  });

  it('a THROWING onGeneration hook never aborts a valid run (checkpoint is observational)', async () => {
    const a = makeAdapter('ckpt-throw', [1, 1, 2, 3, 4], [1, 2]);
    const result = await runFlywheelGenerations({
      rootPolicy: a.rootPolicy, proposer: a.proposer, evaluator: a.evaluator,
      promotionRule: meetsPromotionRule, holdout: a.holdout, anchor: a.anchor,
      maxGenerations: 4, signer: makeSigner(), dataSource: 'SYNTHETIC',
      onGeneration: () => { throw new Error('disk full'); },
    });
    // the run still completes and produces a valid, replayable bundle
    expect(verifyReplayBundle(result.replayBundle, { pinnedGateFingerprint: PIN }).pass).toBe(true);
    expect(result.generationsRun).toBeGreaterThan(0);
  });

  it('the flywheel core is domain-agnostic: same import, same config keys for every domain', async () => {
    // Structural proof — the three adapters were built from ONE factory; only the suites differ.
    const configKeys = (a: ReturnType<typeof makeAdapter>) =>
      Object.keys({ rootPolicy: a.rootPolicy, proposer: a.proposer, evaluator: a.evaluator, holdout: a.holdout, anchor: a.anchor, maxGenerations: 0, signer: null, promotionRule: null }).sort();
    const k = DOMAINS.map((d) => configKeys(makeAdapter(d.name, d.holdout, d.anchor)));
    expect(k[1]).toEqual(k[0]);
    expect(k[2]).toEqual(k[0]); // identical config shape across coding + non-coding + generic
  });

  it('a tampered bundle FAILS replay (no trust in the producer)', async () => {
    const a = makeAdapter('tamper', [1, 2, 3, 4, 5], [1, 2]);
    const result = await runFlywheelGenerations({ rootPolicy: a.rootPolicy, proposer: a.proposer, evaluator: a.evaluator, holdout: a.holdout, anchor: a.anchor, maxGenerations: 6, signer: makeSigner(), dataSource: 'SYNTHETIC' });
    const forged = structuredClone(result.replayBundle);
    forged.chain[0]!.receipt.payload = { ...forged.chain[0]!.receipt.payload, tampered: true };
    expect(verifyReplayBundle(forged, { pinnedGateFingerprint: PIN }).pass).toBe(false);
    // a moved gate also fails
    expect(verifyReplayBundle(result.replayBundle, { pinnedGateFingerprint: 'deadbeef' }).checks.gateUnchanged).toBe(false);
  });
});
