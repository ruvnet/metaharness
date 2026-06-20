// SPDX-License-Identifier: MIT
//
// Darwin Shield statistical promotion (ADR-155 addendum; ADR-079 SGM). Under
// test: the paired seeded bootstrap is deterministic, certifies a real
// improvement (lower95 > 0), refuses a tie/regression, and the champion-vs-
// previous-champion decision rejects any unsafe-output regression.

import { describe, expect, it } from 'vitest';
import { bootstrapDelta, decidePromotion, perRepoFitness } from '../../src/security/stats.js';
import { defaultCorpus } from '../../src/security/corpus.js';
import { baselineGenome } from '../../src/security/genome.js';
import type { HarnessGenome } from '../../src/security/types.js';

const corpus = defaultCorpus();

function strong(): HarnessGenome {
  return {
    ...baselineGenome(),
    id: 'strong',
    planner: 'sink-first',
    contextPolicy: 'hybrid',
    reviewerCount: 4,
    retryBudget: 4,
    fuzzBudgetSeconds: 120,
    tools: ['semgrep', 'codeql', 'osv-scanner', 'trivy', 'npm-audit', 'cargo-audit'],
    modelMix: ['claude'],
  };
}

describe('bootstrapDelta — paired, seeded, deterministic', () => {
  it('certifies a uniformly-better new harness (lower95 > 0)', () => {
    const prev = [0.5, 0.5, 0.5, 0.5, 0.5];
    const next = [0.7, 0.72, 0.69, 0.71, 0.7];
    const b = bootstrapDelta(prev, next, { seed: 0 });
    expect(b.meanDelta).toBeGreaterThan(0.15);
    expect(b.lower95).toBeGreaterThan(0);
    expect(b.promote).toBe(true);
    expect(b.pValue).toBe(0);
  });

  it('refuses a tie (identical distributions ⇒ lower95 = 0, not promoted)', () => {
    const xs = [0.6, 0.6, 0.6, 0.6, 0.6];
    const b = bootstrapDelta(xs, xs, { seed: 1 });
    expect(b.meanDelta).toBe(0);
    expect(b.lower95).toBe(0);
    expect(b.promote).toBe(false);
  });

  it('refuses a regression (new worse than prev)', () => {
    const prev = [0.8, 0.8, 0.8, 0.8, 0.8];
    const next = [0.5, 0.55, 0.52, 0.5, 0.51];
    const b = bootstrapDelta(prev, next, { seed: 2 });
    expect(b.promote).toBe(false);
    expect(b.lower95).toBeLessThan(0);
  });

  it('is byte-reproducible for a fixed seed', () => {
    const prev = [0.5, 0.55, 0.48, 0.6, 0.52];
    const next = [0.7, 0.72, 0.69, 0.8, 0.71];
    expect(bootstrapDelta(prev, next, { seed: 7 })).toEqual(bootstrapDelta(prev, next, { seed: 7 }));
  });

  it('handles empty input safely', () => {
    expect(bootstrapDelta([], [0.5], { seed: 0 }).promote).toBe(false);
  });
});

describe('perRepoFitness — a per-repo sample distribution', () => {
  it('returns one fitness per corpus repo', () => {
    const xs = perRepoFitness(strong(), corpus, 0.5);
    expect(xs).toHaveLength(corpus.repos.length);
    expect(xs.every((v) => typeof v === 'number')).toBe(true);
  });

  it('a strong harness scores higher per-repo than the fixed baseline', () => {
    const strongXs = perRepoFitness(strong(), corpus, 0.5);
    const baseXs = perRepoFitness(baselineGenome(), corpus, 0.5);
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(strongXs)).toBeGreaterThan(mean(baseXs));
  });
});

describe('decidePromotion — champion vs previous champion', () => {
  it('promotes a statistically superior champion with zero unsafe regression', () => {
    const d = decidePromotion(baselineGenome(), strong(), corpus, 0.5, { seed: 0 });
    expect(d.promote).toBe(true);
    expect(d.lower95).toBeGreaterThan(0);
    expect(d.unsafeRegression).toBe(false);
    expect(d.newMeanFitness).toBeGreaterThan(d.prevMeanFitness);
  });

  it('does not promote the baseline against itself (no improvement)', () => {
    const d = decidePromotion(baselineGenome(), baselineGenome(), corpus, 0.5, { seed: 0 });
    expect(d.promote).toBe(false);
  });

  it('is deterministic', () => {
    const a = decidePromotion(baselineGenome(), strong(), corpus, 0.5, { seed: 3 });
    const b = decidePromotion(baselineGenome(), strong(), corpus, 0.5, { seed: 3 });
    expect(a).toEqual(b);
  });
});
