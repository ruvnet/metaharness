import { describe, expect, it } from 'vitest';
import { makeSigner, runFlywheelGenerations, type PolicyGenome } from '@metaharness/flywheel';
import {
  AUTOGENOUS_MUTATION_TARGETS,
  FROZEN_SAME_ACCURACY_BAND,
  autogenousPromotionRule,
  genomeToPolicy,
  makeAutogenousEvaluator,
  makeAutogenousProposer,
  policyToGenome,
  policyViolations,
  projectAutogenousScore,
  rootGenome,
  type AutogenousBenchResult,
} from '../src/index.js';

const bench = (overrides: Partial<AutogenousBenchResult> = {}): AutogenousBenchResult => ({
  separation: 1,
  familyStack: 1.4,
  diversePair: 1.8,
  topicRatio: 5,
  hardGatesPass: true,
  correlatedGainVsBest: 0.25,
  independentGainVsBest: 1 / 3,
  authorized: true,
  reversible: true,
  costUsd: 0,
  ...overrides,
});

describe('@metaharness/autogenous genome', () => {
  it('exposes only the five Autogenous-authorized mutation targets', () => {
    expect(AUTOGENOUS_MUTATION_TARGETS).toEqual([
      'sameProvider', 'sameArch', 'sameSize', 'sourceJaccard', 'quorumThreshold',
    ]);
    expect(genomeToPolicy(rootGenome())).not.toHaveProperty('sameAccuracyBand');
  });

  it('keeps sameAccuracyBand frozen across every policy projection', () => {
    const genome = policyToGenome({
      ...genomeToPolicy(rootGenome()),
      sameAccuracyBand: '0.8',
    });
    expect(genome.weights.sameAccuracyBand).toBe(FROZEN_SAME_ACCURACY_BAND);
    expect(policyViolations({ ...genomeToPolicy(rootGenome()), sameAccuracyBand: '0.8' }))
      .toContain('unknown_lever:sameAccuracyBand');
  });

  it('fails closed on unknown, malformed, and out-of-bounds levers', () => {
    const policy = genomeToPolicy(rootGenome());
    expect(policyViolations({ ...policy, sameProvider: '1.2', extra: '1' })).toEqual([
      'unknown_lever:extra',
      'out_of_bounds:sameProvider',
    ]);
    expect(policyViolations({ ...policy, quorumThreshold: 'NaN' }))
      .toContain('invalid_number:quorumThreshold');
  });

  it('clamps model proposals and refuses unknown targets', async () => {
    const proposer = makeAutogenousProposer({ complete: async () => '99' });
    const base: PolicyGenome = {
      id: 'root', generation: 1, parents: ['root'], policy: genomeToPolicy(rootGenome()),
    };
    expect(await proposer(base, 'sameProvider')).toBe('0.8');
    expect(await proposer(base, 'quorumThreshold')).toBe('4');
    expect(await proposer(base, 'constitutionalGate')).toBe('');
  });
});

describe('@metaharness/autogenous evaluator and gate', () => {
  it('injects the real benchmark seam and marks invalid policy as a regression', async () => {
    let observed = rootGenome();
    const evaluator = makeAutogenousEvaluator(async (genome) => {
      observed = genome;
      return bench();
    });
    const score = await evaluator(
      { ...genomeToPolicy(rootGenome()), sameProvider: '9' },
      { id: 'holdout', items: [] },
    );
    expect(observed.weights.sameProvider).toBe(0.8);
    expect(score.regressed).toBe(true);
    expect(score).toMatchObject({ policyViolations: ['out_of_bounds:sameProvider'] });
  });

  it('promotes only a material, safe, authorized, reversible non-regression', () => {
    const baseline = projectAutogenousScore(bench({ separation: 1 }));
    const candidate = projectAutogenousScore(bench({ separation: 1.03 }));
    expect(autogenousPromotionRule({ baseline, candidate })).toEqual({ promote: true, reasons: [] });

    for (const [name, result] of [
      ['hard_gates_failed', bench({ separation: 1.03, hardGatesPass: false })],
      ['not_authorized', bench({ separation: 1.03, authorized: false })],
      ['not_reversible', bench({ separation: 1.03, reversible: false })],
      ['correlated_quality_regressed', bench({ separation: 1.03, correlatedGainVsBest: 0.2 })],
      ['independent_quality_regressed', bench({ separation: 1.03, independentGainVsBest: 0.3 })],
    ] as const) {
      expect(autogenousPromotionRule({ baseline, candidate: projectAutogenousScore(result) }).reasons)
        .toContain(name);
    }
  });

  it('runs through the generic flywheel with the Autogenous gate', async () => {
    const evaluator = makeAutogenousEvaluator(async (genome) =>
      bench({ separation: genome.weights.sameProvider * 2 }),
    );
    const result = await runFlywheelGenerations({
      rootPolicy: genomeToPolicy(rootGenome()),
      mutationTargets: [...AUTOGENOUS_MUTATION_TARGETS],
      proposer: makeAutogenousProposer({ step: 0.05 }),
      evaluator,
      promotionRule: autogenousPromotionRule,
      holdout: { id: 'synthetic-radio-moe', items: [] },
      maxGenerations: 2,
      signer: makeSigner(),
      dataSource: 'SYNTHETIC',
    });
    expect(result.promotions).toHaveLength(2);
    expect(Number(result.finalPolicy.sameProvider)).toBeCloseTo(0.5);
    expect(result.replayBundle.gate_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
