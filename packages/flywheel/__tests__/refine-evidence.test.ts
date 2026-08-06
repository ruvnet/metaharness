// @metaharness/flywheel — ADR-241 §2.1: refine evidence + rollback-by-construction, ADDITIVE only.
// Test Contract items 2–3: the object-form proposer's evidence-citing summary + inverse reach the
// minted lineage commit; the legacy string-form proposer is byte-for-byte unchanged ('adapt <target>');
// apply-then-rollback restores the parent bytes IDENTICALLY; and the frozen gate did not move —
// gateFingerprint(meetsPromotionRule) is identical before/after the new types load, and a candidate
// failing the rule is still NOT promoted.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  runFlywheelGenerations, meetsPromotionRule, gateFingerprint, makeSigner,
  type Policy, type Proposer, type ProposerResult, type Evaluator, type Score, type Suite,
} from '../src/index.js';
import type { CandidateMutation } from '../src/types.js';

// Fingerprint captured at module load, BEFORE the ADR-241 types below are exercised.
const PIN_BEFORE = gateFingerprint(meetsPromotionRule);

// ── minimal harness (same pattern as acceptance.test.ts): quality = count of '#' across levers. ──
const holdout: Suite = { id: 'holdout', items: [1, 1, 2, 3].map((d, i) => ({ id: `h${i}`, difficulty: d })) };
const evaluator: Evaluator = async (policy: Policy, s: Suite): Promise<Score> => {
  const quality = Object.values(policy).join('').split('#').length - 1;
  let solved = 0;
  for (const item of s.items as Array<{ difficulty: number }>) if (quality >= item.difficulty) solved++;
  const n = Math.max(1, s.items.length);
  return { primary: solved, noopRate: (n - solved) / n, costPerWin: solved > 0 ? 1 / solved : 999, regressed: false };
};
const run = (proposer: Proposer, maxGenerations = 1) =>
  runFlywheelGenerations({
    rootPolicy: { lever: 'base-bytes' }, proposer, evaluator,
    promotionRule: meetsPromotionRule, holdout, maxGenerations,
    signer: makeSigner(), dataSource: 'SYNTHETIC',
  });

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('ADR-241 §2.1 — object-form proposer channel (additive)', () => {
  it("object-form proposer's summary + inverse reach the minted lineage commit", async () => {
    const inverse: NonNullable<CandidateMutation['inverse']> = {
      path: 'lever', parentBytes: 'base-bytes', hash: sha256('base-bytes'),
    };
    const proposer: Proposer = async (base, target): Promise<ProposerResult> => ({
      value: `${base.policy[target]}#`,
      summary: 'refine[lever]: minimal bounded edit (evidence: trace-a1)',
      inverse,
    });
    const result = await run(proposer);
    const commit = result.replayBundle.all_commits.find((c) => c.mutation?.target === 'lever')!;
    expect(commit.verdict).toBe('PROMOTED');
    expect(commit.mutation!.summary).toBe('refine[lever]: minimal bounded edit (evidence: trace-a1)');
    expect(commit.mutation!.inverse).toEqual(inverse);
  });

  it("string-form proposer is unchanged: summary stays exactly 'adapt <target>', no inverse", async () => {
    const proposer: Proposer = async (base, target) => `${base.policy[target]}#`;
    const result = await run(proposer);
    const commit = result.replayBundle.all_commits.find((c) => c.mutation?.target === 'lever')!;
    expect(commit.mutation!.summary).toBe('adapt lever');
    expect(commit.mutation!.inverse).toBeUndefined();
  });

  it('apply-then-rollback: writing parentBytes from the inverse restores the original byte-identically', async () => {
    const original = 'base-bytes';
    const proposer: Proposer = async (base, target): Promise<ProposerResult> => ({
      value: `${base.policy[target]}#`, // the applied edit
      inverse: { path: target, parentBytes: base.policy[target]!, hash: sha256(base.policy[target]!) },
    });
    const result = await run(proposer);
    const commit = result.replayBundle.all_commits.find((c) => c.mutation?.target === 'lever')!;
    // the edit was applied…
    expect(result.finalPolicy.lever).toBe('base-bytes#');
    expect(result.finalPolicy.lever).not.toBe(original);
    // …and rolling back by writing the recorded parentBytes restores the original EXACTLY.
    const inv = commit.mutation!.inverse!;
    const rolledBack: Policy = { ...result.finalPolicy, [inv.path]: inv.parentBytes };
    expect(rolledBack.lever).toBe(original);
    expect(Buffer.from(rolledBack.lever, 'utf8').equals(Buffer.from(original, 'utf8'))).toBe(true);
    expect(sha256(inv.parentBytes)).toBe(inv.hash); // the inverse self-verifies
  });
});

describe('ADR-241 §2.1 — the frozen gate did not move (ADR-072 pin)', () => {
  it('gateFingerprint(meetsPromotionRule) is identical before/after the new types are imported + used', async () => {
    // Force the new types + object-form path through the loop, then re-fingerprint.
    await run(async (base, target): Promise<ProposerResult> => ({ value: `${base.policy[target]}#`, summary: 's' }));
    expect(gateFingerprint(meetsPromotionRule)).toBe(PIN_BEFORE);
  });

  it('a refine candidate failing the frozen rule is NOT promoted', async () => {
    // The proposer removes quality ('#'s never added) ⇒ noopRate cannot strictly improve ⇒ gate rejects.
    const proposer: Proposer = async (): Promise<ProposerResult> => ({
      value: 'no-improvement', summary: 'refine[lever]: does nothing (evidence: trace-z9)',
    });
    const result = await run(proposer, 2);
    expect(result.promotions.filter((c) => c.verdict === 'PROMOTED')).toEqual([]);
    for (const c of result.replayBundle.all_commits) {
      expect(c.verdict).toBe('REJECTED');
      expect(meetsPromotionRule({ baseline: c.baselineScore!, candidate: c.candidateScore! }).promote).toBe(false);
    }
    expect(result.finalPolicy.lever).toBe('base-bytes'); // the head never moved
  });
});
