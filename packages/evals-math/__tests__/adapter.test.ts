// @metaharness/evals-math — $0 SYNTHETIC acceptance test.
//
// Drives the FULL adapter through the real @metaharness/flywheel engine on a deterministic synthetic fixture
// (dataSource 'SYNTHETIC' — never a real GSM8K score). Proves: (1) the harness pipeline + schema-constrained
// proposer produce a COMPOUNDING lift curve that the composite gate admits; (2) the frozen
// `meetsPromotionRule` is composed VERBATIM (its behaviour + fingerprint unchanged); (3) leakage fails
// CLOSED; (4) the replay bundle verifies with the pinned composite-gate fingerprint. This is the math analog
// of the SWE-bench $0 dry-run — the live openai/gsm8k run is deferred until token/network is wired.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  runFlywheelGenerations, makeSigner, verifyReplayBundle, gateFingerprint, meetsPromotionRule,
} from '@metaharness/flywheel';
import {
  rootGenome, genomeToPolicy,
  makeMathEvaluator, makeMathProposer, type SolveFn,
  mathPromotionRule,
  detectLeakage, leaks,
  splitDeterministic, manifestOf, isDisjoint,
  type MathItem, type MathScore,
} from '../src/index.js';

// ── deterministic synthetic fixture ─────────────────────────────────────────────────────────────────────
const hashFrac = (s: string): number => (parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) % 10000) / 10000;

const CATS = ['arithmetic', 'algebra', 'geometry', 'numbertheory', 'combinatorics', 'wordproblem', 'calculus', 'other'] as const;
// N sized so each single mutation step moves BOTH accuracy and no-op monotonically (the spec's ≥300–500
// validation guidance — below that, single-item granularity puts the two signals out of phase). GSM8K
// answers are integers, so the whole fixture is integer-format.
const fixture: MathItem[] = Array.from({ length: 400 }, (_, i) => ({
  id: `syn-${i}`,
  question: `Synthetic GSM8K-shaped math problem ${i} about ${CATS[i % CATS.length]}.`,
  answer: String(i), // the integer gold answer (GSM8K "#### N")
  answerFormat: 'integer',
  category: CATS[i % CATS.length],
}));

/** Deterministic mock model: no network, no clock, no RNG. The effective lever is `maxCandidates` — modeled
 *  as SELF-CONSISTENCY DEPTH (extra samples are free re-reads of the same cheap pass, so cost stays flat).
 *  More depth (a) rescues the hardest problems from an empty/format-invalid output (no-op ↓) and (b) lifts
 *  borderline problems over the correctness bar (accuracy ↑). Cost is held flat to ISOLATE the lift signal —
 *  real token economics are the LIVE run's job, not the $0 replay's. Confidence is high enough that the
 *  root never escalates, so downstream levers (verification/confidence) don't perturb cost here. Wrong
 *  answers are a DISTINCT integer (gold + 100000) so numeric exact-match never accidentally matches. */
const mockSolve: SolveFn = async ({ question, maxCandidates }) => {
  const id = question.match(/problem (\d+)/)?.[1] ?? '0';
  const ease = hashFrac(`syn-${id}`);
  const item = fixture.find((f) => f.id === `syn-${id}`)!;
  const depth = Math.min(3, maxCandidates - 1); // saturates at 3 → the curve plateaus (realistic)
  // emptyBonus kept small enough that the empty/no-op fraction keeps STRICTLY dropping across every depth
  // step (never saturating to zero on the holdout subset) so the frozen gate's strict-noop clause admits
  // each successive promotion — the compounding curve, not a one-shot jump.
  const emptyBonus = depth * 0.03;
  const candBonus = depth * 0.05;

  // hardest problems produce nothing until self-consistency depth surfaces a formatable answer → no-op ↓
  if (ease + emptyBonus < 0.15) return { raw: '', logprob: 0.7, samples: [], costUsd: 0.002 };

  const correct = ease + candBonus >= 0.5;
  const answer = correct ? item.answer : String(Number(item.answer) + 100000);
  const samples = Array.from({ length: Math.max(0, maxCandidates - 1) }, () => answer);
  return { raw: `Let me work through it step by step...\nFinal answer: ${answer}`, logprob: 0.7, samples, costUsd: 0.002 };
};

describe('@metaharness/evals-math — data contract', () => {
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

describe('@metaharness/evals-math — the frozen gate is composed verbatim', () => {
  it('mathPromotionRule calls the frozen meetsPromotionRule (base reasons surface)', () => {
    // a candidate that regresses primary must be rejected WITH the frozen base reason present
    const baseline = { primary: 0.5, noopRate: 0.2, costPerWin: 1, regressed: false, accuracy: 0.5, costPerCorrect: 1, calibrationError: 0.1, formatErrorRate: 0.1, abstentionRate: 0, perSubjectAccuracy: {}, n: 10, correct: 5 } as MathScore;
    const worse = { ...baseline, primary: 0.4, accuracy: 0.4, correct: 4 } as MathScore;
    const d = mathPromotionRule({ baseline, candidate: worse });
    expect(d.promote).toBe(false);
    expect(d.reasons).toContain('primary_regressed'); // proves the frozen clause ran
  });

  it('the composite gate has a DIFFERENT fingerprint than the frozen default (it is a stricter superset)', () => {
    expect(gateFingerprint(mathPromotionRule)).not.toBe(gateFingerprint(meetsPromotionRule));
  });

  it('admits an accuracy win and a cost win; rejects an immaterial change', () => {
    const b = { primary: 0.5, noopRate: 0.2, costPerWin: 1, regressed: false, accuracy: 0.5, costPerCorrect: 1, calibrationError: 0.1, formatErrorRate: 0.1, abstentionRate: 0, perSubjectAccuracy: {}, n: 100, correct: 50 } as MathScore;
    const accWin = { ...b, primary: 0.53, accuracy: 0.53, noopRate: 0.15, costPerWin: 0.9, costPerCorrect: 0.9, correct: 53 } as MathScore;
    const costWin = { ...b, noopRate: 0.15, costPerWin: 0.5, costPerCorrect: 0.5 } as MathScore;
    const immaterial = { ...b, noopRate: 0.15, primary: 0.505, accuracy: 0.505, costPerWin: 0.99, costPerCorrect: 0.99 } as MathScore;
    expect(mathPromotionRule({ baseline: b, candidate: accWin }).promote).toBe(true);
    expect(mathPromotionRule({ baseline: b, candidate: costWin }).promote).toBe(true);
    expect(mathPromotionRule({ baseline: b, candidate: immaterial }).reasons).toContain('immaterial_no_accuracy_or_cost_win');
  });
});

describe('@metaharness/evals-math — leakage fails closed', () => {
  it('a policy that encodes a benchmark artifact is rejected', () => {
    const g = rootGenome();
    (g.subjectPolicy as any).arithmetic = { ...g.defaults, solverStyle: 'answer from gsm8k gold answer' };
    expect(leaks(detectLeakage(g, []))).toBe(true);
  });
  it('the evaluator marks a leaked policy regressed → the gate rejects it', async () => {
    const g = rootGenome();
    (g.subjectPolicy as any).arithmetic = { ...g.defaults, solverStyle: 'openai/gsm8k test split lookup' };
    const evaluate = makeMathEvaluator({ solve: mockSolve });
    const score = (await evaluate(genomeToPolicy(g), { id: 'v', items: fixture.slice(0, 10) })) as MathScore;
    expect(score.regressed).toBe(true);
  });
});

describe('@metaharness/evals-math — end-to-end flywheel produces a compounding, replayable lift curve', () => {
  it('promotes ≥2 anchor-surviving improvements and the replay bundle verifies', async () => {
    const split = splitDeterministic(fixture);
    const evaluate = makeMathEvaluator({ solve: mockSolve, publicExamples: split.publicDev.map((i) => i.question) });
    const proposer = makeMathProposer(); // $0 deterministic
    const result = await runFlywheelGenerations({
      rootPolicy: genomeToPolicy(rootGenome()),
      proposer,
      evaluator: evaluate,
      promotionRule: mathPromotionRule,
      holdout: { id: 'math-validation', items: split.privateValidation },
      anchor: { id: 'math-anchor', items: split.publicDev },
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
    const v = verifyReplayBundle(result.replayBundle, { pinnedGateFingerprint: gateFingerprint(mathPromotionRule) });
    expect(v.pass).toBe(true);
    expect(result.replayBundle.data_source).toBe('SYNTHETIC');
    expect(result.replayBundle.gate_fingerprint).toBe(gateFingerprint(mathPromotionRule));
  });
});
