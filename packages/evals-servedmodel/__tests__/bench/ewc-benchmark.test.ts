// @metaharness/evals-servedmodel — EWC++ / quality-vs-cost BENCHMARK (ADR-234).
//
// Not a flywheel run — a direct A/B on the evaluator, isolating ONE variable (ewcLambda) while holding
// every other lever fixed at the most drift-prone settings (rank=4, routingDepth=8, adaptationMode=
// 'aggressive' — maximum adaptation surface). This is the $0 measurement backing ADR-234 §3's claim that
// EWC++ (`ewcLambda`) resists regression on the anchor/retained-capability signal, and the ADR-234 §5
// stability/plasticity tradeoff (protecting 'core' costs some 'domain' lift — never free).
//
// Cheap by construction: pure functions + a deterministic mock over a fixed 400-item suite, no network, no
// clock, <50ms wall time — this is the ADR-234 §7 "keep the micro-loop evaluation cheap" requirement.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  rootGenome, adaptationAggressiveness, genomeToPolicy,
  makeServedModelEvaluator, detectDriftRisk, driftRisky, driftPressure,
  type AdaptationTask, type ServedModelPolicyGenome, type ServedModelScore,
} from '../../src/index.js';

const hashFrac = (s: string): number => (parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) % 10000) / 10000;

const suite: AdaptationTask[] = Array.from({ length: 400 }, (_, i) => ({
  id: `bench-${i}`,
  capabilityClass: i % 3 === 0 ? 'core' : 'domain',
}));

// Same deterministic model as the adapter test's $0 mock (kept in sync deliberately — a benchmark that
// drifts from the acceptance test's dynamics would silently stop measuring what it claims to).
async function solve({ genome, task }: { genome: ServedModelPolicyGenome; task: AdaptationTask }) {
  const ease = hashFrac(task.id);
  const depthScore =
    ((genome.microloraRank - 1) / 3) * 0.4 +
    ((genome.routingDepth - 1) / 7) * 0.4 +
    (adaptationAggressiveness(genome.adaptationMode) / 3) * 0.2;
  const committed = ease + depthScore * 0.5 >= genome.qualityThreshold;
  if (!committed) return { afterQuality: ease * 0.3, costUsd: 0.001, latencyMs: 4, committed: false };
  if (task.capabilityClass === 'domain') {
    const afterQuality = Math.min(1, ease * 0.5 + depthScore * 0.5 + 0.05);
    return { afterQuality, costUsd: 0.002, latencyMs: 6 + genome.routingDepth, committed: true };
  }
  const pressure = driftPressure(genome);
  const baseline = ease * 0.5 + 0.3;
  const afterQuality = Math.max(0, baseline - pressure * 0.4);
  return { afterQuality, costUsd: 0.002, latencyMs: 6 + genome.routingDepth, committed: true };
}

const MAX_DRIFT_SETTINGS = { microloraRank: 4, routingDepth: 8, adaptationMode: 'aggressive' as const };
const LOW_EWC = 0.02;
const HIGH_EWC = 0.6;

describe('@metaharness/evals-servedmodel — EWC++ resists anchor regression (benchmark)', () => {
  it('a high ewcLambda preserves core (retained-capability) quality much better than a low one, at maximum drift settings', async () => {
    const evaluate = makeServedModelEvaluator({ solve });
    const lowEwcGenome: ServedModelPolicyGenome = { ...rootGenome(), ...MAX_DRIFT_SETTINGS, ewcLambda: LOW_EWC };
    const highEwcGenome: ServedModelPolicyGenome = { ...rootGenome(), ...MAX_DRIFT_SETTINGS, ewcLambda: HIGH_EWC };

    const lowScore = (await evaluate(genomeToPolicy(lowEwcGenome), { id: 'bench', items: suite })) as ServedModelScore;
    const highScore = (await evaluate(genomeToPolicy(highEwcGenome), { id: 'bench', items: suite })) as ServedModelScore;

    const protectionGainPp = (highScore.coreMeanQuality - lowScore.coreMeanQuality) * 100;
    const domainCostPp = (lowScore.meanQuality - highScore.meanQuality) * 100; // stability/plasticity tradeoff
    const report = {
      lowEwc: { ewcLambda: LOW_EWC, coreMeanQuality: lowScore.coreMeanQuality, meanQuality: lowScore.meanQuality, costPerAdaptedWin: lowScore.costPerAdaptedWin, driftRisk: lowScore.driftRisk },
      highEwc: { ewcLambda: HIGH_EWC, coreMeanQuality: highScore.coreMeanQuality, meanQuality: highScore.meanQuality, costPerAdaptedWin: highScore.costPerAdaptedWin, driftRisk: highScore.driftRisk },
      protectionGainPp: Number(protectionGainPp.toFixed(2)),
      domainCostPp: Number(domainCostPp.toFixed(2)),
    };
    // eslint-disable-next-line no-console
    console.log('[evals-servedmodel bench] EWC++ anchor-protection A/B:', JSON.stringify(report, null, 2));

    // EWC++ measurably protects retained capability at maximum drift settings.
    expect(highScore.coreMeanQuality).toBeGreaterThan(lowScore.coreMeanQuality);
    expect(protectionGainPp).toBeGreaterThan(1); // >1pp — not noise at n≈133 core items

    // The structural guard independently flags the low-ewc/aggressive combination (defense in depth —
    // this would be caught even before any suite is scored).
    expect(driftRisky(detectDriftRisk({ ...rootGenome(), ...MAX_DRIFT_SETTINGS, ewcLambda: LOW_EWC }))).toBe(true);
    expect(driftRisky(detectDriftRisk({ ...rootGenome(), ...MAX_DRIFT_SETTINGS, ewcLambda: HIGH_EWC }))).toBe(false);
  });

  it('quality-vs-cost: adaptation depth (rank × routingDepth) trades cost/win for higher commit + quality', async () => {
    const evaluate = makeServedModelEvaluator({ solve });
    const shallow: ServedModelPolicyGenome = { ...rootGenome(), microloraRank: 1, routingDepth: 1, adaptationMode: 'off' };
    const deep: ServedModelPolicyGenome = { ...rootGenome(), microloraRank: 4, routingDepth: 8, adaptationMode: 'balanced', ewcLambda: 0.3 };

    const shallowScore = (await evaluate(genomeToPolicy(shallow), { id: 'bench', items: suite })) as ServedModelScore;
    const deepScore = (await evaluate(genomeToPolicy(deep), { id: 'bench', items: suite })) as ServedModelScore;

    const report = {
      shallow: { meanQuality: shallowScore.meanQuality, noCommitRate: shallowScore.noCommitRate, costPerAdaptedWin: shallowScore.costPerAdaptedWin },
      deep: { meanQuality: deepScore.meanQuality, noCommitRate: deepScore.noCommitRate, costPerAdaptedWin: deepScore.costPerAdaptedWin },
    };
    // eslint-disable-next-line no-console
    console.log('[evals-servedmodel bench] quality-vs-cost (adaptation depth):', JSON.stringify(report, null, 2));

    expect(deepScore.meanQuality).toBeGreaterThan(shallowScore.meanQuality);
    expect(deepScore.noCommitRate).toBeLessThan(shallowScore.noCommitRate);
  });
});
