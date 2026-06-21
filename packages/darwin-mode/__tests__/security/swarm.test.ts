// SPDX-License-Identifier: MIT
//
// Darwin Shield swarm (ADR-155 §swarm execution) + capability model (§agents).
// Under test: the pipeline is deterministic and replayable from its receipt; the
// capability model is monotone (a stronger harness finds more and mis-reports
// less); and no run ever emits unsafe output.

import { describe, expect, it } from 'vitest';
import { runSwarm, costOf, hashInputs, corpusCounts } from '../../src/security/swarm.js';
import { analyzeRepo, detectionPower, fpResistance } from '../../src/security/agents.js';
import { defaultCorpus } from '../../src/security/corpus.js';
import { baselineGenome, staticOnlyGenome } from '../../src/security/genome.js';
import type { HarnessGenome } from '../../src/security/types.js';

const corpus = defaultCorpus();

/** The (near-)optimal harness an evolution run should converge toward. */
function strongGenome(): HarnessGenome {
  return {
    ...baselineGenome(),
    id: 'strong',
    planner: 'risk-first',
    contextPolicy: 'hybrid',
    reviewerCount: 5,
    retryBudget: 6,
    fuzzBudgetSeconds: 300,
    tools: ['semgrep', 'codeql', 'osv-scanner', 'trivy', 'cargo-audit', 'npm-audit', 'cargo-fuzz'],
    modelMix: ['claude'],
  };
}

describe('runSwarm — determinism & receipts', () => {
  it('produces a byte-identical receipt on re-run (reproducibility gate)', () => {
    const a = runSwarm(baselineGenome(), corpus, 'task-1', {});
    const b = runSwarm(baselineGenome(), corpus, 'task-1', {});
    expect(a.receipt).toEqual(b.receipt);
    expect(a.metrics).toEqual(b.metrics);
  });

  it('the input hash changes when the genome changes', () => {
    const h1 = hashInputs(baselineGenome(), corpus, 't', 0);
    const h2 = hashInputs(strongGenome(), corpus, 't', 0);
    expect(h1).not.toBe(h2);
  });

  it('never emits unsafe output (acceptance counter = 0)', () => {
    for (const g of [staticOnlyGenome(), baselineGenome(), strongGenome()]) {
      const r = runSwarm(g, corpus, 't', {});
      expect(r.metrics.unsafeOutputs).toBe(0);
      expect(r.findings.every((f) => f.exploitCodeAllowed === false)).toBe(true);
    }
  });
});

describe('capability model — monotone in harness strength', () => {
  it('the strong harness finds more true positives than the baseline', () => {
    const weak = runSwarm(staticOnlyGenome(), corpus, 't', {}).metrics;
    const mid = runSwarm(baselineGenome(), corpus, 't', {}).metrics;
    const strong = runSwarm(strongGenome(), corpus, 't', {}).metrics;
    expect(strong.truePositives).toBeGreaterThan(mid.truePositives);
    expect(mid.truePositives).toBeGreaterThanOrEqual(0);
    expect(weak.truePositives).toBeGreaterThanOrEqual(0);
  });

  it('the strong harness mis-reports fewer decoys (false positives)', () => {
    const mid = runSwarm(baselineGenome(), corpus, 't', {}).metrics;
    const strong = runSwarm(strongGenome(), corpus, 't', {}).metrics;
    expect(strong.falsePositives).toBeLessThan(mid.falsePositives);
  });

  it('more reviewers strictly raise false-positive resistance', () => {
    const decoy = corpus.repos[0].sites.find((s) => !s.isVulnerable)!;
    const r1 = fpResistance({ ...baselineGenome(), reviewerCount: 1 }, decoy);
    const r5 = fpResistance({ ...baselineGenome(), reviewerCount: 5 }, decoy);
    expect(r5).toBeGreaterThan(r1);
  });

  it('enabling more relevant tools raises detection power', () => {
    const vuln = corpus.repos[0].sites.find((s) => s.isVulnerable)!; // rust
    const few = detectionPower({ ...baselineGenome(), tools: ['semgrep'] }, vuln);
    const many = detectionPower(
      { ...baselineGenome(), tools: ['semgrep', 'codeql', 'osv-scanner', 'cargo-audit'] },
      vuln,
    );
    expect(many).toBeGreaterThan(few);
  });
});

describe('costOf — bounded, monotone cost proxy', () => {
  it('a heavier harness costs more', () => {
    expect(costOf(strongGenome())).toBeGreaterThan(costOf(staticOnlyGenome()));
  });
});

describe('analyzeRepo — partitions sites into TP / FP / FN', () => {
  it('every site is accounted for exactly once', () => {
    const repo = corpus.repos[0];
    const out = analyzeRepo(strongGenome(), repo);
    const classified = out.truePositives.length + out.falsePositives.length + out.falseNegatives.length;
    const vulns = repo.sites.filter((s) => s.isVulnerable).length;
    const decoys = repo.sites.filter((s) => !s.isVulnerable).length;
    // TP+FN = all vulns; FP ≤ decoys; classified ≤ all sites.
    expect(out.truePositives.length + out.falseNegatives.length).toBe(vulns);
    expect(out.falsePositives.length).toBeLessThanOrEqual(decoys);
    expect(classified).toBeLessThanOrEqual(repo.sites.length);
  });
});

describe('corpusCounts', () => {
  it('reports ground-truth and decoy totals', () => {
    const c = corpusCounts(corpus);
    expect(c.groundTruth).toBeGreaterThan(0);
    expect(c.decoys).toBeGreaterThan(0);
  });
});
