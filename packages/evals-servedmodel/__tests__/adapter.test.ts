// @metaharness/evals-servedmodel — $0 SYNTHETIC acceptance test (ADR-234).
//
// Drives the FULL adapter through the real @metaharness/flywheel engine on a deterministic synthetic
// fixture (dataSource 'SYNTHETIC' — never a real served-model score). Proves: (1) the served-model pipeline
// + schema-constrained proposer produce a COMPOUNDING lift curve the composite gate admits; (2) the frozen
// `meetsPromotionRule` is composed VERBATIM (behaviour + fingerprint unchanged); (3) the structural
// drift-risk guard fails CLOSED; (4) the replay bundle verifies with the pinned composite-gate fingerprint.
// This is the ruvllm-served-model analog of the HLE/SWE-bench $0 dry-runs — a real `ruvllm serve` run is
// deferred (see `ruvllmClient.ts` — gated behind an explicit `live` flag this test never sets).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  runFlywheelGenerations, makeSigner, verifyReplayBundle, gateFingerprint, meetsPromotionRule,
} from '@metaharness/flywheel';
import {
  rootGenome, genomeToPolicy, adaptationAggressiveness,
  makeServedModelEvaluator, makeServedModelProposer, type ServedModelSolveFn,
  servedModelPromotionRule,
  detectDriftRisk, driftRisky, driftPressure,
  splitDeterministic, manifestOf, isDisjoint,
  distillPolicyFromState, checkDistillationEligibility,
  type AdaptationTask, type ServedModelScore, type ServedModelPolicyGenome,
} from '../src/index.js';

// ── deterministic synthetic fixture ─────────────────────────────────────────────────────────────────────
const hashFrac = (s: string): number => (parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) % 10000) / 10000;

// N sized so single-lever mutation steps move commit-rate and quality in tandem (mirrors evals-hle's
// 400-item sizing rationale). Every 3rd item is 'core' (retained capability the EWC guard protects).
const fixture: AdaptationTask[] = Array.from({ length: 400 }, (_, i) => ({
  id: `task-${i}`,
  capabilityClass: i % 3 === 0 ? 'core' : 'domain',
  prompt: `Synthetic served-model adaptation task ${i}`,
}));

/** Deterministic mock served model: no network, no clock, no RNG.
 *  - "commit" (SONA quality_threshold gate) is easier to clear as adaptation DEPTH (rank + routingDepth +
 *    mode aggressiveness) rises — mirrors evals-hle's self-consistency-depth rescue mechanic (no-op ↓).
 *  - 'domain' items gain quality from that same depth (the live interaction stream the micro-loop is
 *    adapting toward — accuracy ↑).
 *  - 'core' items are a STABLE baseline eroded by `driftPressure` (rank/depth/aggressiveness net of
 *    ewcLambda) — the retained-capability signal the anchor + composite gate must catch if it decays
 *    too far. This is the $0 model of ADR-234 §3's "does it forget?" oracle. */
const mockSolve: ServedModelSolveFn = async ({ genome, task }) => {
  const ease = hashFrac(task.id);
  const depthScore =
    ((genome.microloraRank - 1) / 3) * 0.4 +
    ((genome.routingDepth - 1) / 7) * 0.4 +
    (adaptationAggressiveness(genome.adaptationMode) / 3) * 0.2; // [0,1]

  const committed = ease + depthScore * 0.5 >= genome.qualityThreshold;
  if (!committed) return { afterQuality: ease * 0.3, costUsd: 0.001, latencyMs: 4, committed: false };

  if (task.capabilityClass === 'domain') {
    const afterQuality = Math.min(1, ease * 0.5 + depthScore * 0.5 + 0.05);
    return { afterQuality, costUsd: 0.002, latencyMs: 6 + genome.routingDepth, committed: true };
  }

  const pressure = driftPressure(genome); // [0,1]-ish, net of ewcLambda
  const baseline = ease * 0.5 + 0.3;
  const afterQuality = Math.max(0, baseline - pressure * 0.4);
  return { afterQuality, costUsd: 0.002, latencyMs: 6 + genome.routingDepth, committed: true };
};

describe('@metaharness/evals-servedmodel — data contract', () => {
  it('splits deterministically into four disjoint sets with stable hashes', () => {
    const s1 = splitDeterministic(fixture);
    const s2 = splitDeterministic(fixture);
    expect(isDisjoint(s1)).toBe(true);
    expect(manifestOf(s1).splitFingerprint).toBe(manifestOf(s2).splitFingerprint);
    expect(s1.frozenHoldout.length).toBeGreaterThan(0);
    expect(s1.privateValidation.length).toBeGreaterThan(0);
  });
});

describe('@metaharness/evals-servedmodel — the frozen gate is composed verbatim', () => {
  it('servedModelPromotionRule calls the frozen meetsPromotionRule (base reasons surface)', () => {
    const baseline: ServedModelScore = {
      primary: 0.5, noopRate: 0.3, costPerWin: 1, regressed: false,
      meanQuality: 0.5, costPerAdaptedWin: 1, latencyMsP50: 10, noCommitRate: 0.3,
      coreMeanQuality: 0.4, driftRisk: false, n: 100,
    };
    const worse = { ...baseline, primary: 0.4, meanQuality: 0.4 };
    const d = servedModelPromotionRule({ baseline, candidate: worse });
    expect(d.promote).toBe(false);
    expect(d.reasons).toContain('primary_regressed');
  });

  it('the composite gate has a DIFFERENT fingerprint than the frozen default (a stricter superset)', () => {
    expect(gateFingerprint(servedModelPromotionRule)).not.toBe(gateFingerprint(meetsPromotionRule));
  });

  it('rejects a candidate that erodes retained (core) capability even if primary improved', () => {
    const baseline: ServedModelScore = {
      primary: 0.5, noopRate: 0.3, costPerWin: 1, regressed: false,
      meanQuality: 0.5, costPerAdaptedWin: 1, latencyMsP50: 10, noCommitRate: 0.3,
      coreMeanQuality: 0.5, driftRisk: false, n: 100,
    };
    const candidate: ServedModelScore = {
      ...baseline, primary: 0.6, meanQuality: 0.6, noopRate: 0.2, noCommitRate: 0.2,
      coreMeanQuality: 0.3, // big core regression
    };
    const d = servedModelPromotionRule({ baseline, candidate });
    expect(d.promote).toBe(false);
    expect(d.reasons).toContain('core_capability_regressed');
  });
});

describe('@metaharness/evals-servedmodel — drift-risk guard fails closed', () => {
  it('aggressive mode with ewcLambda below the aggressive-mode floor is flagged structurally', () => {
    const g: ServedModelPolicyGenome = { ...rootGenome(), adaptationMode: 'aggressive', ewcLambda: 0.05 };
    const risk = detectDriftRisk(g);
    expect(risk.aggressiveWithoutEwc).toBe(true);
    expect(driftRisky(risk)).toBe(true);
  });

  it('the evaluator marks a structurally-risky policy `regressed` → the base gate rejects it', async () => {
    const g: ServedModelPolicyGenome = { ...rootGenome(), adaptationMode: 'aggressive', ewcLambda: 0.02, routingDepth: 8 };
    const evaluate = makeServedModelEvaluator({ solve: mockSolve });
    const score = (await evaluate(genomeToPolicy(g), { id: 'v', items: fixture.slice(0, 20) })) as ServedModelScore;
    expect(score.regressed).toBe(true);
    expect(score.driftRisk).toBe(true);
  });

  it('conservative default genome is NOT flagged risky', () => {
    expect(driftRisky(detectDriftRisk(rootGenome()))).toBe(false);
  });
});

describe('@metaharness/evals-servedmodel — distillation', () => {
  it('a promoted MicroLoRA/SONA state distills deterministically into a genome candidate', () => {
    const state = {
      microlora: { rank: 3, scaling: 0.5, samplesSeen: 120, qualitySum: 90, weightMagnitude: 2.1 },
      sona: { hidden: 64, capacity: 128, ewcLambda: 0.2, emaDecay: 0.96, qualityThreshold: 0.55, qualityEma: 0.7 },
    };
    const g1 = distillPolicyFromState(state);
    const g2 = distillPolicyFromState(state);
    expect(g1).toEqual(g2); // deterministic — same state, same genome
    expect(g1.microloraRank).toBe(3);
    expect(g1.ewcLambda).toBeCloseTo(0.2);
  });

  it('gates distillation on samples_seen before it is even eligible', () => {
    const low = checkDistillationEligibility(
      { microlora: { rank: 2, scaling: 0.5, samplesSeen: 3, qualitySum: 2, weightMagnitude: 1 }, sona: { hidden: 64, capacity: 128, ewcLambda: 0.1, emaDecay: 0.95, qualityThreshold: 0.5, qualityEma: 0.5 } },
      50,
    );
    expect(low.eligible).toBe(false);
  });
});

describe('@metaharness/evals-servedmodel — end-to-end flywheel produces a compounding, replayable lift curve', () => {
  it('promotes ≥2 anchor-surviving improvements and the replay bundle verifies', async () => {
    const split = splitDeterministic(fixture);
    const evaluate = makeServedModelEvaluator({ solve: mockSolve });
    const proposer = makeServedModelProposer(); // $0 deterministic

    const result = await runFlywheelGenerations({
      rootPolicy: genomeToPolicy(rootGenome()),
      proposer,
      evaluator: evaluate,
      promotionRule: servedModelPromotionRule,
      holdout: { id: 'servedmodel-validation', items: split.privateValidation },
      anchor: { id: 'servedmodel-anchor', items: split.publicDev },
      mutationTargets: ['routingDepth', 'microloraRank', 'adaptationMode', 'qualityThreshold'],
      maxGenerations: 8,
      signer: makeSigner(),
      dataSource: 'SYNTHETIC',
    });

    const curve = result.liftCurve;
    expect(curve[curve.length - 1].primary).toBeGreaterThan(curve[0].primary);
    expect(result.milestoneReached).toBe(true); // ≥2 anchor-surviving verified improvements

    const v = verifyReplayBundle(result.replayBundle, {
      pinnedGateFingerprint: gateFingerprint(servedModelPromotionRule),
      promotionRule: servedModelPromotionRule,
    });
    expect(v.pass).toBe(true);
    expect(v.checks.gateReExecutes).toBe(true);
    expect(result.replayBundle.data_source).toBe('SYNTHETIC');
    expect(result.replayBundle.gate_fingerprint).toBe(gateFingerprint(servedModelPromotionRule));
  });
});
