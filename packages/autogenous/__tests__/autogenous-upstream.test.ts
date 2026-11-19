// Real-package tests: these import the published `autogenous` (AGL, Rust compiled to
// WebAssembly) and `radio-moe` packages. Nothing upstream is mocked.
import { describe, expect, it } from 'vitest';
import { gateFingerprint, makeSigner, runFlywheelGenerations, verifyReplayBundle } from '@metaharness/flywheel';
import { scopePolicy } from 'autogenous';
import {
  CEILINGS,
  DEFAULT_INDEPENDENCE_WEIGHTS,
  PROMOTION_MARGIN,
  evaluateMeshParams,
} from 'radio-moe';
import {
  AUTOGENOUS_CEILINGS,
  AUTOGENOUS_MUTATION_TARGETS,
  makeAutogenousProposer,
  AUTOGENOUS_MUTATION_SCOPE,
  AUTOGENOUS_PROMOTION_MARGIN,
  admitAutogenousPolicy,
  autogenousPromotionRule,
  genomeToPolicy,
  makeAutogenousEvaluator,
  policyViolations,
  radioMoeParentGenome,
  referenceChampionGenome,
  rootGenome,
  type AutogenousBenchRunner,
  type AutogenousScore,
} from '../src/index.js';

/** A bench runner whose fitness half is radio-moe's own deterministic evaluate(). */
const radioMoeBench: AutogenousBenchRunner = async (genome) => ({
  ...evaluateMeshParams(genome),
  correlatedGainVsBest: 0.25,
  independentGainVsBest: 1 / 3,
  authorized: true,
  reversible: true,
  costUsd: 0,
});

const suite = { id: 'radio-moe-frozen-bench', items: [] };

describe('@metaharness/autogenous uses radio-moe as the source of truth', () => {
  it('takes ceilings, defaults and margin from radio-moe', () => {
    expect(AUTOGENOUS_CEILINGS).toBe(CEILINGS);
    expect(AUTOGENOUS_PROMOTION_MARGIN).toBe(PROMOTION_MARGIN);
    const { sameProvider, sameArch, sameSize, sourceJaccard, sameAccuracyBand } = DEFAULT_INDEPENDENCE_WEIGHTS;
    expect(rootGenome().weights).toEqual({ sameProvider, sameArch, sameSize, sourceJaccard, sameAccuracyBand });
  });

  it("promotes radio-moe's reference champion over the root via promoteAuthorized", async () => {
    const evaluate = makeAutogenousEvaluator(radioMoeBench, { admission: { now: () => 0 } });
    const baseline = (await evaluate(genomeToPolicy(rootGenome()), suite)) as AutogenousScore;
    const candidate = (await evaluate(genomeToPolicy(referenceChampionGenome()), suite)) as AutogenousScore;
    expect(baseline.separation).toBeCloseTo(0.6875);
    expect(candidate.separation).toBeCloseTo(1.25);
    // radio-moe reports Infinity; signed receipts need a finite value.
    expect(evaluateMeshParams(referenceChampionGenome()).topicRatio).toBe(Infinity);
    expect(candidate.topicRatio).toBe(Number.MAX_VALUE);
    expect(candidate.regressed).toBe(false);
    expect(candidate.aglAdmission).toEqual({ admissible: true });
    expect(autogenousPromotionRule({ baseline, candidate })).toEqual({ promote: true, reasons: [] });
    // The reverse direction is not Better, so the radio-moe core refuses it.
    expect(autogenousPromotionRule({ baseline: candidate, candidate: baseline }).reasons)
      .toEqual(['insufficient_separation_lift']);
  });
});

describe('@metaharness/autogenous AGL admission (autogenous wasm)', () => {
  it('treats a radio-moe candidate as an auto-promotable routing_budget mutation', () => {
    expect(scopePolicy(AUTOGENOUS_MUTATION_SCOPE)).toEqual({
      scope: 'routing_budget', autoPromotable: true, minAuthority: 'auto_reversible',
    });
    const policy = genomeToPolicy(rootGenome());
    expect(admitAutogenousPolicy(policy, policyViolations(policy), { now: () => 0 }))
      .toEqual({ admissible: true });
  });

  it('refuses a policy that unfreezes sameAccuracyBand, and the gate blocks it', async () => {
    const evaluate = makeAutogenousEvaluator(radioMoeBench, { admission: { now: () => 0 } });
    const baseline = (await evaluate(genomeToPolicy(rootGenome()), suite)) as AutogenousScore;
    const candidate = (await evaluate(
      { ...genomeToPolicy(referenceChampionGenome()), sameAccuracyBand: '0.5' },
      suite,
    )) as AutogenousScore;
    expect(candidate.aglAdmission).toMatchObject({ admissible: false, reason: 'invariant_regressed' });
    expect(candidate.authorized).toBe(false);
    const decision = autogenousPromotionRule({ baseline, candidate });
    expect(decision.promote).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      'not_authorized', 'agl_admission_refused:invariant_regressed',
    ]));
  });

  it('refuses an irreversible candidate through AGL no_rollback', async () => {
    const evaluate = makeAutogenousEvaluator(
      async (genome) => ({ ...(await radioMoeBench(genome, suite)), reversible: false }),
      { admission: { now: () => 0 } },
    );
    const score = (await evaluate(genomeToPolicy(referenceChampionGenome()), suite)) as AutogenousScore;
    expect(score.aglAdmission).toMatchObject({ admissible: false, reason: 'no_rollback' });
    expect(score.authorized).toBe(false);
  });

  it('refuses when the parent genome cannot grant auto_reversible authority', () => {
    const parent = { ...radioMoeParentGenome(), capability_ceiling: 'simulate_only' as const };
    const policy = genomeToPolicy(rootGenome());
    expect(admitAutogenousPolicy(policy, [], { parent, now: () => 0 }))
      .toMatchObject({ admissible: false, reason: 'authority_expansion' });
  });
});

describe('@metaharness/autogenous end to end on real radio-moe fitness', () => {
  it('runs the flywheel and its replay bundle verifies, also after a JSON round trip', async () => {
    const result = await runFlywheelGenerations({
      rootPolicy: genomeToPolicy(rootGenome()),
      mutationTargets: [...AUTOGENOUS_MUTATION_TARGETS],
      proposer: makeAutogenousProposer({ step: 0.05 }),
      evaluator: makeAutogenousEvaluator(radioMoeBench, { admission: { now: () => 0 } }),
      promotionRule: autogenousPromotionRule,
      holdout: suite,
      maxGenerations: 2,
      signer: makeSigner(),
      dataSource: 'AUTOGENOUS_RADIO_MOE',
    });
    expect(result.promotions.length).toBeGreaterThan(0);
    const pins = {
      pinnedGateFingerprint: gateFingerprint(autogenousPromotionRule),
      promotionRule: autogenousPromotionRule,
    };
    const live = verifyReplayBundle(result.replayBundle, pins);
    expect(live.failures).toEqual([]);
    expect(live.pass).toBe(true);
    const persisted = verifyReplayBundle(JSON.parse(JSON.stringify(result.replayBundle)), pins);
    expect(persisted.failures).toEqual([]);
    expect(persisted.pass).toBe(true);
  });
});
