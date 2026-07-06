// @metaharness/evals-sql — $0 SYNTHETIC acceptance test.
//
// Drives the FULL adapter through the real @metaharness/flywheel engine on a deterministic synthetic fixture
// (dataSource 'SYNTHETIC' — never a real execution-match score). Proves: (1) the harness pipeline +
// schema-constrained proposer produce a COMPOUNDING lift curve that the composite gate admits; (2) the frozen
// `meetsPromotionRule` is composed VERBATIM (its behaviour + fingerprint unchanged); (3) leakage fails
// CLOSED; (4) the replay bundle verifies with the pinned composite-gate fingerprint. This is the text-to-SQL
// analog of the SWE-bench $0 dry-run — the live run (real Spider-style data + a local DB for execution-match)
// is deferred until that data + DBs are provisioned.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  runFlywheelGenerations, makeSigner, verifyReplayBundle, gateFingerprint, meetsPromotionRule,
} from '@metaharness/flywheel';
import {
  rootGenome, genomeToPolicy,
  makeSqlEvaluator, makeSqlProposer, type SolveFn,
  sqlPromotionRule,
  detectLeakage, leaks,
  splitDeterministic, manifestOf, isDisjoint,
  type SqlItem, type SqlScore,
} from '../src/index.js';

// ── deterministic synthetic fixture ─────────────────────────────────────────────────────────────────────
const hashFrac = (s: string): number => (parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) % 10000) / 10000;

const TYPES = ['select', 'aggregate', 'join', 'nested', 'groupby', 'orderby', 'setops', 'other'] as const;
// N sized so each single mutation step moves BOTH accuracy and no-op monotonically (the spec's ≥300–500
// validation guidance — below that, single-item granularity puts the two signals out of phase).
const fixture: SqlItem[] = Array.from({ length: 400 }, (_, i) => ({
  id: `syn-${i}`,
  question: `Synthetic text-to-SQL question ${i} over the ${TYPES[i % TYPES.length]} schema.`,
  // gold SQL — a valid SELECT the normalizer extracts + canonicalizes to a stable form.
  gold: `SELECT c${i} FROM t${i % 8}`,
  dialect: 'sqlite',
  category: TYPES[i % TYPES.length],
}));

/** Deterministic mock model: no network, no clock, no RNG. The effective lever is `maxCandidates` — modeled
 *  as SELF-CONSISTENCY DEPTH (extra samples are free re-reads of the same cheap pass, so cost stays flat).
 *  More depth (a) rescues the hardest items from an empty/invalid output (no-op ↓) and (b) lifts borderline
 *  items over the execution-match bar (accuracy ↑). Cost is held flat to ISOLATE the lift signal — real token
 *  economics are the LIVE run's job, not the $0 replay's. Confidence is high enough that the root never
 *  escalates, so downstream levers (verification/confidence) don't perturb cost here. */
const mockSolve: SolveFn = async ({ question, maxCandidates }) => {
  const id = question.match(/question (\d+)/)?.[1] ?? '0';
  const ease = hashFrac(`syn-${id}`);
  const item = fixture.find((f) => f.id === `syn-${id}`)!;
  const depth = Math.min(3, maxCandidates - 1); // saturates at 3 → the curve plateaus (realistic)
  const emptyBonus = depth * 0.06;
  const candBonus = depth * 0.05;

  // hardest items produce nothing until self-consistency depth surfaces a formatable query → no-op ↓
  if (ease + emptyBonus < 0.15) return { raw: '', logprob: 0.7, samples: [], costUsd: 0.002 };

  const correct = ease + candBonus >= 0.5;
  const sql = correct ? item.gold : `SELECT x FROM wrong_${id}`;
  const samples = Array.from({ length: Math.max(0, maxCandidates - 1) }, () => sql);
  return { raw: `-- reasoning about the query\n${sql}`, logprob: 0.7, samples, costUsd: 0.002 };
};

describe('@metaharness/evals-sql — data contract', () => {
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

describe('@metaharness/evals-sql — the frozen gate is composed verbatim', () => {
  it('sqlPromotionRule calls the frozen meetsPromotionRule (base reasons surface)', () => {
    // a candidate that regresses primary must be rejected WITH the frozen base reason present
    const baseline = { primary: 0.5, noopRate: 0.2, costPerWin: 1, regressed: false, accuracy: 0.5, costPerCorrect: 1, calibrationError: 0.1, invalidSqlRate: 0.1, abstentionRate: 0, perTypeAccuracy: {}, n: 10, correct: 5 } as SqlScore;
    const worse = { ...baseline, primary: 0.4, accuracy: 0.4, correct: 4 } as SqlScore;
    const d = sqlPromotionRule({ baseline, candidate: worse });
    expect(d.promote).toBe(false);
    expect(d.reasons).toContain('primary_regressed'); // proves the frozen clause ran
  });

  it('the composite gate has a DIFFERENT fingerprint than the frozen default (it is a stricter superset)', () => {
    expect(gateFingerprint(sqlPromotionRule)).not.toBe(gateFingerprint(meetsPromotionRule));
  });

  it('admits an accuracy win and a cost win; rejects an immaterial change', () => {
    const b = { primary: 0.5, noopRate: 0.2, costPerWin: 1, regressed: false, accuracy: 0.5, costPerCorrect: 1, calibrationError: 0.1, invalidSqlRate: 0.1, abstentionRate: 0, perTypeAccuracy: {}, n: 100, correct: 50 } as SqlScore;
    const accWin = { ...b, primary: 0.53, accuracy: 0.53, noopRate: 0.15, costPerWin: 0.9, costPerCorrect: 0.9, correct: 53 } as SqlScore;
    const costWin = { ...b, noopRate: 0.15, costPerWin: 0.5, costPerCorrect: 0.5 } as SqlScore;
    const immaterial = { ...b, noopRate: 0.15, primary: 0.505, accuracy: 0.505, costPerWin: 0.99, costPerCorrect: 0.99 } as SqlScore;
    expect(sqlPromotionRule({ baseline: b, candidate: accWin }).promote).toBe(true);
    expect(sqlPromotionRule({ baseline: b, candidate: costWin }).promote).toBe(true);
    expect(sqlPromotionRule({ baseline: b, candidate: immaterial }).reasons).toContain('immaterial_no_accuracy_or_cost_win');
  });
});

describe('@metaharness/evals-sql — leakage fails closed', () => {
  it('a policy that encodes a benchmark artifact is rejected', () => {
    const g = rootGenome();
    (g.typePolicy as any).select = { ...g.defaults, decodingStyle: 'answer from spider dev split gold sql' };
    expect(leaks(detectLeakage(g, []))).toBe(true);
  });
  it('the evaluator marks a leaked policy regressed → the gate rejects it', async () => {
    const g = rootGenome();
    (g.typePolicy as any).select = { ...g.defaults, decodingStyle: 'gold sql = select memoized query lookup' };
    const evaluate = makeSqlEvaluator({ solve: mockSolve });
    const score = (await evaluate(genomeToPolicy(g), { id: 'v', items: fixture.slice(0, 10) })) as SqlScore;
    expect(score.regressed).toBe(true);
  });
});

describe('@metaharness/evals-sql — end-to-end flywheel produces a compounding, replayable lift curve', () => {
  it('promotes ≥2 anchor-surviving improvements and the replay bundle verifies', async () => {
    const split = splitDeterministic(fixture);
    const evaluate = makeSqlEvaluator({ solve: mockSolve, publicExamples: split.publicDev.map((i) => i.question) });
    const proposer = makeSqlProposer(); // $0 deterministic
    const result = await runFlywheelGenerations({
      rootPolicy: genomeToPolicy(rootGenome()),
      proposer,
      evaluator: evaluate,
      promotionRule: sqlPromotionRule,
      holdout: { id: 'sql-validation', items: split.privateValidation },
      anchor: { id: 'sql-anchor', items: split.publicDev },
      mutationTargets: ['verificationMode', 'maxCandidates', 'confidenceRule', 'normalizeSql'],
      maxGenerations: 8,
      signer: makeSigner(),
      dataSource: 'SYNTHETIC',
    });

    // compounding: final promoted primary strictly above the root
    const curve = result.liftCurve;
    expect(curve[curve.length - 1].primary).toBeGreaterThan(curve[0].primary);
    expect(result.milestoneReached).toBe(true); // ≥2 anchor-surviving verified improvements

    // external replay verifies against the PINNED composite-gate fingerprint
    const v = verifyReplayBundle(result.replayBundle, { pinnedGateFingerprint: gateFingerprint(sqlPromotionRule) });
    expect(v.pass).toBe(true);
    expect(result.replayBundle.data_source).toBe('SYNTHETIC');
    expect(result.replayBundle.gate_fingerprint).toBe(gateFingerprint(sqlPromotionRule));
  });
});
