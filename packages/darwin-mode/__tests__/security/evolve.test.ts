// SPDX-License-Identifier: MIT
//
// Darwin Shield evolution loop (ADR-155 §decision). Under test: the loop runs the
// full 50 cycles, the champion beats the fixed baseline, the search is
// deterministic for a fixed seed, and the learning curve is monotone
// non-decreasing (elitism never loses the best harness).

import { describe, expect, it } from 'vitest';
import { evolve } from '../../src/security/evolve.js';
import { defaultCorpus } from '../../src/security/corpus.js';
import { isGenomeValid } from '../../src/security/genome.js';
import { runSwarm, corpusCounts } from '../../src/security/swarm.js';

const corpus = defaultCorpus();
const b2FpRate =
  runSwarm({
    id: 'baseline',
    planner: 'file-first',
    contextPolicy: 'semantic',
    reviewerCount: 1,
    retryBudget: 2,
    fuzzBudgetSeconds: 60,
    tools: ['semgrep', 'osv-scanner'],
    modelMix: ['claude'],
    validationPipeline: ['static', 'fuzz', 'repro-test', 'review'],
    safetyProfile: 'strict-defensive',
  }, corpus, 'b2', {}).metrics.falsePositives / corpusCounts(corpus).decoys;

function run(seed: number) {
  return evolve({ corpus, population: 12, cycles: 50, seed, baselineFalsePositiveRate: b2FpRate });
}

describe('evolve — convergence', () => {
  it('runs the full 50 cycles', () => {
    const r = run(0);
    expect(r.cyclesRun).toBe(50);
    expect(r.history).toHaveLength(50);
    expect(r.evaluations).toBeGreaterThan(0);
  });

  it('the champion beats the fixed baseline', () => {
    const r = run(0);
    expect(r.champion.breakdown.fitness).toBeGreaterThan(r.baseline.breakdown.fitness);
    expect(isGenomeValid(r.champion.genome)).toBe(true);
  });

  it('the learning curve never goes down (elitism)', () => {
    const r = run(0);
    for (let i = 1; i < r.history.length; i += 1) {
      expect(r.history[i]).toBeGreaterThanOrEqual(r.history[i - 1]);
    }
  });

  it('the champion has zero unsafe outputs and a real lineage', () => {
    const r = run(0);
    expect(r.champion.breakdown.unsafeOutputs).toBe(0);
    expect(r.lineage[0]).toBe('baseline');
    expect(r.lineage.length).toBeGreaterThanOrEqual(1);
  });
});

describe('evolve — determinism', () => {
  it('the same seed yields the same champion fitness & lineage length', () => {
    const a = run(7);
    const b = run(7);
    expect(a.champion.breakdown).toEqual(b.champion.breakdown);
    expect(a.history).toEqual(b.history);
    expect(a.lineage.length).toBe(b.lineage.length);
  });
});
