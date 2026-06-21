// SPDX-License-Identifier: MIT
//
// Darwin Shield performance budget (ADR-155 acceptance: retrieval latency
// p95 ≤ 150 ms). The deterministic, dependency-free embedding/ranking path must
// stay well inside the budget so the swarm's context builder is never the
// bottleneck. Also guards that a full 50-cycle benchmark completes promptly.

import { describe, expect, it } from 'vitest';
import { RuvSecurityMemory } from '../../src/security/memory.js';
import { defaultCorpus, groundTruth } from '../../src/security/corpus.js';
import { runBenchmark } from '../../src/security/bench.js';

describe('retrieval latency budget (p95 ≤ 150 ms)', () => {
  it('hybrid retrieval over an indexed corpus stays well under budget', () => {
    const corpus = defaultCorpus();
    const mem = new RuvSecurityMemory();
    for (const repo of corpus.repos) mem.indexSites(repo.repo, repo.commit, repo.sites);
    // Populate memory so retrieval does real work (confirmed + false positives).
    for (const s of groundTruth(corpus)) {
      mem.writeConfirmed({
        id: s.siteId,
        repo: corpus.id,
        commit: corpus.version,
        file: s.file,
        symbol: s.symbol,
        weakness: s.weakness,
        confidence: 0.9,
        evidence: [s.weakness],
        patch: s.acceptedPatch ?? 'fix',
        test: 'regression test',
        verdict: 'confirmed',
        exploitCodeAllowed: false,
      });
    }

    const queries = groundTruth(corpus).map((s) => `${s.weakness} ${s.symbol}`);
    const latencies: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const q = queries[i % queries.length];
      const t0 = performance.now();
      mem.recallAtK(q, [q], 20);
      mem.falsePositiveSimilarity(q);
      mem.retrievePatches(q, 3);
      latencies.push(performance.now() - t0);
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    expect(p95).toBeLessThanOrEqual(150);
  });
});

describe('benchmark throughput', () => {
  it('a full 50-cycle / 16-population benchmark completes under 10 s', () => {
    const t0 = performance.now();
    const report = runBenchmark({ population: 16, cycles: 50, seed: 0 });
    const elapsed = performance.now() - t0;
    expect(report.passed).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  });
});
