// @metaharness/evals-extract — $0 SYNTHETIC acceptance test.
//
// Drives the FULL adapter through the real @metaharness/flywheel engine on a deterministic synthetic fixture
// (dataSource 'SYNTHETIC' — never a real extraction score). Proves: (1) the harness pipeline + schema-
// constrained proposer produce a COMPOUNDING lift curve that the composite gate admits; (2) the frozen
// `meetsPromotionRule` is composed VERBATIM (its behaviour + fingerprint unchanged); (3) leakage fails
// CLOSED; (4) the replay bundle verifies with the pinned composite-gate fingerprint. This is the extraction
// analog of the SWE-bench $0 dry-run — the live gated/licensed-data run is deferred until access is granted.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  runFlywheelGenerations, makeSigner, verifyReplayBundle, gateFingerprint, meetsPromotionRule,
} from '@metaharness/flywheel';
import {
  rootGenome, genomeToPolicy,
  makeExtractEvaluator, makeExtractProposer, type SolveFn,
  extractPromotionRule,
  detectLeakage, leaks,
  splitDeterministic, manifestOf, isDisjoint,
  type ExtractItem, type ExtractScore, type JsonSchema,
} from '../src/index.js';

// ── deterministic synthetic fixture ─────────────────────────────────────────────────────────────────────
const hashFrac = (s: string): number => (parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) % 10000) / 10000;

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: { name: { type: 'string' }, amount: { type: 'number' }, flag: { type: 'boolean' } },
  required: ['name', 'amount'],
  additionalProperties: false,
};
const goldObj = (i: number): Record<string, unknown> => ({ name: `n${i}`, amount: i, flag: i % 2 === 0 });

const CATS = ['invoice', 'receipt', 'resume', 'contract', 'email', 'form', 'article', 'other'] as const;
// N sized so each single mutation step moves BOTH accuracy and no-op monotonically (the spec's ≥300–500
// validation guidance — below that, single-item granularity puts the two signals out of phase).
const fixture: ExtractItem[] = Array.from({ length: 400 }, (_, i) => ({
  id: `syn-${i}`,
  text: `Synthetic ${CATS[i % CATS.length]} document ${i} to extract.`,
  schema: SCHEMA,
  gold: JSON.stringify(goldObj(i)),
  category: CATS[i % CATS.length],
}));

/** Deterministic mock model: no network, no clock, no RNG. The effective lever is `maxCandidates` — modeled
 *  as SELF-CONSISTENCY DEPTH (extra samples are free re-reads of the same cheap pass, so cost stays flat).
 *  More depth (a) rescues the hardest documents from an empty/schema-invalid output (no-op ↓) and (b) lifts
 *  borderline documents over the field-correctness bar (accuracy ↑). Cost is held flat to ISOLATE the lift
 *  signal — real token economics are the LIVE run's job, not the $0 replay's. Self-report is high enough that
 *  the root never escalates on committed docs, so downstream levers don't perturb cost here. */
const mockSolve: SolveFn = async ({ text, maxCandidates }) => {
  const id = text.match(/document (\d+)/)?.[1] ?? '0';
  const ease = hashFrac(`syn-${id}`);
  const depth = Math.min(3, maxCandidates - 1); // saturates at 3 → the curve plateaus (realistic)
  const emptyBonus = depth * 0.06;
  const candBonus = depth * 0.05;

  // hardest documents produce nothing until self-consistency depth surfaces a parseable object → no-op ↓
  if (ease + emptyBonus < 0.15) return { raw: '', selfReport: 0.7, samples: [], costUsd: 0.002 };

  const correct = ease + candBonus >= 0.5;
  const emitted = correct ? JSON.stringify(goldObj(Number(id))) : JSON.stringify({ name: `wrong-${id}`, amount: -1, flag: false });
  const samples = Array.from({ length: Math.max(0, maxCandidates - 1) }, () => emitted);
  return { raw: `Here is the extraction:\n${emitted}`, selfReport: 0.7, samples, costUsd: 0.002 };
};

const baseScore = (over: Partial<ExtractScore> = {}): ExtractScore => ({
  primary: 0.5, noopRate: 0.2, costPerWin: 1, regressed: false,
  accuracy: 0.5, costPerCorrect: 1, calibrationError: 0.1, schemaErrorRate: 0.1,
  abstentionRate: 0, perDocTypeAccuracy: {}, n: 100, correct: 50, ...over,
});

describe('@metaharness/evals-extract — data contract', () => {
  it('splits deterministically into four disjoint sets with stable hashes', () => {
    const s1 = splitDeterministic(fixture);
    const s2 = splitDeterministic(fixture);
    expect(isDisjoint(s1)).toBe(true);
    expect(manifestOf(s1).splitFingerprint).toBe(manifestOf(s2).splitFingerprint);
    // frozen holdout carved first → present + non-empty
    expect(s1.frozenHoldout.length).toBeGreaterThan(0);
    expect(s1.privateValidation.length).toBeGreaterThan(0);
  });
});

describe('@metaharness/evals-extract — the frozen gate is composed verbatim', () => {
  it('extractPromotionRule calls the frozen meetsPromotionRule (base reasons surface)', () => {
    // a candidate that regresses primary must be rejected WITH the frozen base reason present
    const baseline = baseScore({ n: 10, correct: 5 });
    const worse = baseScore({ primary: 0.4, accuracy: 0.4, correct: 4, n: 10 });
    const d = extractPromotionRule({ baseline, candidate: worse });
    expect(d.promote).toBe(false);
    expect(d.reasons).toContain('primary_regressed'); // proves the frozen clause ran
  });

  it('the composite gate has a DIFFERENT fingerprint than the frozen default (it is a stricter superset)', () => {
    expect(gateFingerprint(extractPromotionRule)).not.toBe(gateFingerprint(meetsPromotionRule));
  });

  it('admits an accuracy win and a cost win; rejects an immaterial change', () => {
    const b = baseScore();
    const accWin = baseScore({ primary: 0.53, accuracy: 0.53, noopRate: 0.15, costPerWin: 0.9, costPerCorrect: 0.9, correct: 53 });
    const costWin = baseScore({ noopRate: 0.15, costPerWin: 0.5, costPerCorrect: 0.5 });
    const immaterial = baseScore({ noopRate: 0.15, primary: 0.505, accuracy: 0.505, costPerWin: 0.99, costPerCorrect: 0.99 });
    expect(extractPromotionRule({ baseline: b, candidate: accWin }).promote).toBe(true);
    expect(extractPromotionRule({ baseline: b, candidate: costWin }).promote).toBe(true);
    expect(extractPromotionRule({ baseline: b, candidate: immaterial }).reasons).toContain('immaterial_no_accuracy_or_cost_win');
  });
});

describe('@metaharness/evals-extract — leakage fails closed', () => {
  it('a policy that encodes a benchmark artifact is rejected', () => {
    const g = rootGenome();
    (g.docTypePolicy as any).invoice = { ...g.defaults, extractionStyle: 'answer from the gold extraction record' };
    expect(leaks(detectLeakage(g, []))).toBe(true);
  });
  it('the evaluator marks a leaked policy regressed → the gate rejects it', async () => {
    const g = rootGenome();
    (g.docTypePolicy as any).invoice = { ...g.defaults, extractionStyle: 'gold record test split lookup' };
    const evaluate = makeExtractEvaluator({ solve: mockSolve });
    const score = (await evaluate(genomeToPolicy(g), { id: 'v', items: fixture.slice(0, 10) })) as ExtractScore;
    expect(score.regressed).toBe(true);
  });
});

describe('@metaharness/evals-extract — end-to-end flywheel produces a compounding, replayable lift curve', () => {
  it('promotes ≥2 anchor-surviving improvements and the replay bundle verifies', async () => {
    const split = splitDeterministic(fixture);
    const evaluate = makeExtractEvaluator({ solve: mockSolve, publicExamples: split.publicDev.map((i) => i.text) });
    const proposer = makeExtractProposer(); // $0 deterministic
    const result = await runFlywheelGenerations({
      rootPolicy: genomeToPolicy(rootGenome()),
      proposer,
      evaluator: evaluate,
      promotionRule: extractPromotionRule,
      holdout: { id: 'extract-validation', items: split.privateValidation },
      anchor: { id: 'extract-anchor', items: split.publicDev },
      mutationTargets: ['verificationMode', 'maxCandidates', 'confidenceRule', 'normalizeFields'],
      maxGenerations: 8,
      signer: makeSigner(),
      dataSource: 'SYNTHETIC',
    });

    // compounding: final promoted primary strictly above the root
    const curve = result.liftCurve;
    expect(curve[curve.length - 1].primary).toBeGreaterThan(curve[0].primary);
    expect(result.milestoneReached).toBe(true); // ≥2 anchor-surviving verified improvements

    // external replay verifies against the PINNED composite-gate fingerprint
    const v = verifyReplayBundle(result.replayBundle, { pinnedGateFingerprint: gateFingerprint(extractPromotionRule) });
    expect(v.pass).toBe(true);
    expect(result.replayBundle.data_source).toBe('SYNTHETIC');
    expect(result.replayBundle.gate_fingerprint).toBe(gateFingerprint(extractPromotionRule));
  });
});
