// @metaharness/evals-hle — $0 SYNTHETIC acceptance test.
//
// Drives the FULL adapter through the real @metaharness/flywheel engine on a deterministic synthetic fixture
// (dataSource 'SYNTHETIC' — never a real HLE score). Proves: (1) the harness pipeline + schema-constrained
// proposer produce a COMPOUNDING lift curve that the composite gate admits; (2) the frozen
// `meetsPromotionRule` is composed VERBATIM (its behaviour + fingerprint unchanged); (3) leakage fails
// CLOSED; (4) the replay bundle verifies with the pinned composite-gate fingerprint. This is the HLE analog
// of the SWE-bench $0 dry-run — the live gated-data run is deferred until cais/hle access is granted.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  runFlywheelGenerations, makeSigner, verifyReplayBundle, gateFingerprint, meetsPromotionRule,
} from '@metaharness/flywheel';
import {
  rootGenome, genomeToPolicy, policyToGenome,
  makeHleEvaluator, makeHleProposer, type SolveFn,
  hlePromotionRule, subjectRegressionCount,
  detectLeakage, leaks,
  splitDeterministic, manifestOf, isDisjoint,
  type HleItem, type HleScore,
} from '../src/index.js';

// ── deterministic synthetic fixture ─────────────────────────────────────────────────────────────────────
const hashFrac = (s: string): number => (parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) % 10000) / 10000;

const FORMATS = ['short', 'numeric', 'choice', 'equation'] as const;
const CATS = ['math', 'physics', 'chemistry', 'biology', 'cs', 'law', 'history', 'other'] as const;
// N sized so each single mutation step moves BOTH accuracy and no-op monotonically (the spec's ≥300–500
// validation guidance — below that, single-item granularity puts the two signals out of phase).
const fixture: HleItem[] = Array.from({ length: 400 }, (_, i) => ({
  id: `syn-${i}`,
  question: `Synthetic HLE-shaped question ${i} about ${CATS[i % CATS.length]}.`,
  answer: FORMATS[i % FORMATS.length] === 'numeric' ? String(i) : `ans${i}`,
  answerFormat: FORMATS[i % FORMATS.length],
  category: CATS[i % CATS.length],
}));

/** Deterministic mock model: no network, no clock, no RNG. The effective lever is `maxCandidates` — modeled
 *  as SELF-CONSISTENCY DEPTH (extra samples are free re-reads of the same cheap pass, so cost stays flat).
 *  More depth (a) rescues the hardest items from an empty/format-invalid output (no-op ↓) and (b) lifts
 *  borderline items over the correctness bar (accuracy ↑). Cost is held flat to ISOLATE the lift signal —
 *  real token economics are the LIVE run's job, not the $0 replay's. Confidence is high enough that the
 *  root never escalates, so downstream levers (verification/confidence) don't perturb cost here. */
const mockSolve: SolveFn = async ({ question, maxCandidates }) => {
  const id = question.match(/question (\d+)/)?.[1] ?? '0';
  const ease = hashFrac(`syn-${id}`);
  const item = fixture.find((f) => f.id === `syn-${id}`)!;
  const depth = Math.min(3, maxCandidates - 1); // saturates at 3 → the curve plateaus (realistic)
  const emptyBonus = depth * 0.06;
  const candBonus = depth * 0.05;

  // hardest items produce nothing until self-consistency depth surfaces a formatable answer → no-op ↓
  if (ease + emptyBonus < 0.15) return { raw: '', logprob: 0.7, samples: [], costUsd: 0.002 };

  const correct = ease + candBonus >= 0.5;
  const answer = correct ? item.answer : `wrong-${id}`;
  const samples = Array.from({ length: Math.max(0, maxCandidates - 1) }, () => answer);
  return { raw: `Reasoning...\nFinal answer: ${answer}`, logprob: 0.7, samples, costUsd: 0.002 };
};

describe('@metaharness/evals-hle — data contract', () => {
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

describe('@metaharness/evals-hle — the frozen gate is composed verbatim', () => {
  it('hlePromotionRule calls the frozen meetsPromotionRule (base reasons surface)', () => {
    // a candidate that regresses primary must be rejected WITH the frozen base reason present
    const baseline = { primary: 0.5, noopRate: 0.2, costPerWin: 1, regressed: false, accuracy: 0.5, costPerCorrect: 1, calibrationError: 0.1, formatErrorRate: 0.1, abstentionRate: 0, perSubjectAccuracy: {}, n: 10, correct: 5 } as HleScore;
    const worse = { ...baseline, primary: 0.4, accuracy: 0.4, correct: 4 } as HleScore;
    const d = hlePromotionRule({ baseline, candidate: worse });
    expect(d.promote).toBe(false);
    expect(d.reasons).toContain('primary_regressed'); // proves the frozen clause ran
  });

  it('the composite gate has a DIFFERENT fingerprint than the frozen default (it is a stricter superset)', () => {
    expect(gateFingerprint(hlePromotionRule)).not.toBe(gateFingerprint(meetsPromotionRule));
  });

  it('admits an accuracy win and a cost win; rejects an immaterial change', () => {
    const b = { primary: 0.5, noopRate: 0.2, costPerWin: 1, regressed: false, accuracy: 0.5, costPerCorrect: 1, calibrationError: 0.1, formatErrorRate: 0.1, abstentionRate: 0, perSubjectAccuracy: {}, n: 100, correct: 50 } as HleScore;
    const accWin = { ...b, primary: 0.53, accuracy: 0.53, noopRate: 0.15, costPerWin: 0.9, costPerCorrect: 0.9, correct: 53 } as HleScore;
    const costWin = { ...b, noopRate: 0.15, costPerWin: 0.5, costPerCorrect: 0.5 } as HleScore;
    const immaterial = { ...b, noopRate: 0.15, primary: 0.505, accuracy: 0.505, costPerWin: 0.99, costPerCorrect: 0.99 } as HleScore;
    expect(hlePromotionRule({ baseline: b, candidate: accWin }).promote).toBe(true);
    expect(hlePromotionRule({ baseline: b, candidate: costWin }).promote).toBe(true);
    expect(hlePromotionRule({ baseline: b, candidate: immaterial }).reasons).toContain('immaterial_no_accuracy_or_cost_win');
  });
});

describe('@metaharness/evals-hle — leakage fails closed', () => {
  it('a policy that encodes a benchmark artifact is rejected', () => {
    const g = rootGenome();
    (g.subjectPolicy as any).math = { ...g.defaults, solverStyle: "answer from humanity's last exam gold answer" };
    expect(leaks(detectLeakage(g, []))).toBe(true);
  });
  it('the evaluator marks a leaked policy regressed → the gate rejects it', async () => {
    const g = rootGenome();
    (g.subjectPolicy as any).math = { ...g.defaults, solverStyle: 'cais/hle test split lookup' };
    const evaluate = makeHleEvaluator({ solve: mockSolve });
    const score = (await evaluate(genomeToPolicy(g), { id: 'v', items: fixture.slice(0, 10) })) as HleScore;
    expect(score.regressed).toBe(true);
  });
});

describe('@metaharness/evals-hle — end-to-end flywheel produces a compounding, replayable lift curve', () => {
  it('promotes ≥2 anchor-surviving improvements and the replay bundle verifies', async () => {
    const split = splitDeterministic(fixture);
    const evaluate = makeHleEvaluator({ solve: mockSolve, publicExamples: split.publicDev.map((i) => i.question) });
    const proposer = makeHleProposer(); // $0 deterministic
    const result = await runFlywheelGenerations({
      rootPolicy: genomeToPolicy(rootGenome()),
      proposer,
      evaluator: evaluate,
      promotionRule: hlePromotionRule,
      holdout: { id: 'hle-validation', items: split.privateValidation },
      anchor: { id: 'hle-anchor', items: split.publicDev },
      mutationTargets: ['verificationMode', 'maxCandidates', 'confidenceRule', 'normalizeFinalAnswer'],
      maxGenerations: 8,
      signer: makeSigner(),
      dataSource: 'SYNTHETIC',
    });

    // compounding: final promoted primary strictly above the root
    const curve = result.liftCurve;
    expect(curve[curve.length - 1].primary).toBeGreaterThan(curve[0].primary);
    expect(result.milestoneReached).toBe(true); // ≥2 anchor-surviving verified improvements

    // external replay verifies against the PINNED composite-gate fingerprint
    const v = verifyReplayBundle(result.replayBundle, { pinnedGateFingerprint: gateFingerprint(hlePromotionRule) });
    expect(v.pass).toBe(true);
    expect(result.replayBundle.data_source).toBe('SYNTHETIC');
    expect(result.replayBundle.gate_fingerprint).toBe(gateFingerprint(hlePromotionRule));
  });
});
