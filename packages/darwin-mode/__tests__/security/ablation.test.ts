// SPDX-License-Identifier: MIT
//
// Darwin Shield ablation + hard-corpus stress (ADR-155; thesis ADR-077). Two
// credibility checks: (1) knocking out harness levers measurably hurts the
// champion — the gain is from the HARNESS, not the frozen model; (2) on a
// deliberately hard corpus the champion is on an UNSATURATED frontier (TPR < 1)
// yet still dominates the fixed harness.

import { describe, expect, it } from 'vitest';
import { ablate, corpusFitness, hardCorpus } from '../../src/security/ablation.js';
import { hardCorpusStressTest, runBenchmark } from '../../src/security/bench.js';
import { defaultCorpus } from '../../src/security/corpus.js';
import { baselineGenome } from '../../src/security/genome.js';
import type { HarnessGenome } from '../../src/security/types.js';

const corpus = defaultCorpus();

function champion(): HarnessGenome {
  return {
    ...baselineGenome(),
    id: 'champ',
    planner: 'sink-first',
    contextPolicy: 'hybrid',
    reviewerCount: 4,
    retryBudget: 4,
    fuzzBudgetSeconds: 120,
    tools: ['semgrep', 'codeql', 'osv-scanner', 'trivy'],
    modelMix: ['claude'],
  };
}

describe('ablate — the harness is the lever', () => {
  const report = ablate(champion(), corpus, 0.888889);

  it('removing context, tools, or reviewers measurably lowers fitness', () => {
    const byLever = new Map(report.levers.map((l) => [l.lever.split(' ')[0], l.delta]));
    expect(byLever.get('context')!).toBeGreaterThan(0);
    expect(byLever.get('tools')!).toBeGreaterThan(0);
    expect(byLever.get('reviewers')!).toBeGreaterThan(0);
  });

  it('every reported delta is non-negative and the top lever is identified', () => {
    for (const l of report.levers) expect(l.delta).toBeGreaterThanOrEqual(0);
    expect(report.topLever).toBeTruthy();
    // The levers are sorted by impact (descending).
    for (let i = 1; i < report.levers.length; i += 1) {
      expect(report.levers[i - 1].delta).toBeGreaterThanOrEqual(report.levers[i].delta);
    }
  });

  it('is deterministic', () => {
    expect(ablate(champion(), corpus, 0.888889)).toEqual(ablate(champion(), corpus, 0.888889));
  });
});

describe('corpusFitness — aggregate helper', () => {
  it('a stronger harness scores higher than the baseline on the corpus', () => {
    expect(corpusFitness(champion(), corpus, 0.888889)).toBeGreaterThan(
      corpusFitness(baselineGenome(), corpus, 0.888889),
    );
  });
});

describe('hardCorpus — an unsaturated frontier', () => {
  it('the default benchmark champion saturates the easy corpus (TPR = 1)', () => {
    const r = runBenchmark({ population: 12, cycles: 30, seed: 0 });
    expect(r.champion.breakdown.truePositiveRate).toBe(1);
  });

  it('on the hard corpus the champion has headroom yet still beats the fixed harness', () => {
    const s = hardCorpusStressTest({ population: 16, cycles: 50, seed: 0 });
    expect(s.hasHeadroom).toBe(true); // TPR < 1.0 — not saturated
    expect(s.championTpr).toBeGreaterThan(s.baselineTpr);
    expect(s.beatsBaseline).toBe(true);
    expect(s.championFitness).toBeGreaterThan(s.baselineFitness);
  });

  it('the hard corpus carries both vulnerabilities and decoys', () => {
    const hc = hardCorpus();
    const vulns = hc.repos.flatMap((r) => r.sites.filter((x) => x.isVulnerable));
    const decoys = hc.repos.flatMap((r) => r.sites.filter((x) => !x.isVulnerable));
    expect(vulns.length).toBeGreaterThan(0);
    expect(decoys.length).toBeGreaterThan(0);
  });
});
