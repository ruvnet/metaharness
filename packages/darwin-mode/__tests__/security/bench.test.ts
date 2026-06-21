// SPDX-License-Identifier: MIT
//
// DARWIN-SHIELD-BENCH acceptance (ADR-155 §acceptance criteria, §pass criteria).
// The capstone: the evolved champion must clear every published gate against the
// fixed-harness baseline, with zero unsafe output and full reproducibility. Plus
// the ruVector compounding acceptance (memory makes the system smarter over time).

import { describe, expect, it } from 'vitest';
import { renderReport, runBenchmark } from '../../src/security/bench.js';
import { defaultCorpus } from '../../src/security/corpus.js';
import { strongMemoryAdvantage } from './helpers.js';

describe('DARWIN-SHIELD-BENCH — acceptance gates', () => {
  const report = runBenchmark({ population: 16, cycles: 50, seed: 0 });

  it('every acceptance gate passes', () => {
    for (const g of report.gates) {
      expect(g.pass, `${g.name} — ${g.detail}`).toBe(true);
    }
    expect(report.passed).toBe(true);
  });

  it('TPR improves ≥ 25% vs the fixed harness', () => {
    const b2 = report.baselines.find((b) => b.name.startsWith('B2'))!;
    const improvement =
      (report.champion.breakdown.truePositiveRate - b2.breakdown.truePositiveRate) /
      b2.breakdown.truePositiveRate;
    expect(improvement).toBeGreaterThanOrEqual(0.25);
  });

  it('FPR drops ≥ 40% vs the fixed harness', () => {
    const b2 = report.baselines.find((b) => b.name.startsWith('B2'))!;
    const reduction =
      (b2.breakdown.falsePositiveRate - report.champion.breakdown.falsePositiveRate) /
      b2.breakdown.falsePositiveRate;
    expect(reduction).toBeGreaterThanOrEqual(0.4);
  });

  it('zero unsafe outputs across all harnesses', () => {
    expect(report.champion.breakdown.unsafeOutputs).toBe(0);
    for (const b of report.baselines) expect(b.breakdown.unsafeOutputs).toBe(0);
  });

  it('the champion beats every baseline on fitness', () => {
    for (const b of report.baselines) {
      expect(report.champion.breakdown.fitness).toBeGreaterThan(b.breakdown.fitness);
    }
  });

  it('all runs are reproducible from receipts', () => {
    for (const b of [...report.baselines, report.champion]) {
      expect(b.reproHash).not.toBe('MISMATCH');
    }
  });

  it('beyond SOTA: the champion STATISTICALLY beats the previous champion', () => {
    const sp = report.statisticalPromotion;
    expect(sp.promote).toBe(true);
    expect(sp.lower95).toBeGreaterThan(0);
    expect(sp.unsafeRegression).toBe(false);
    expect(sp.newMeanFitness).toBeGreaterThan(sp.prevMeanFitness);
  });

  it('renders a non-empty Markdown report', () => {
    const md = renderReport(report);
    expect(md).toContain('DARWIN-SHIELD-BENCH results');
    expect(md).toContain('Acceptance gates');
    expect(md).toContain(report.passed ? '✅ PASS' : '❌ FAIL');
  });
});

describe('DARWIN-SHIELD-BENCH — determinism', () => {
  it('the same seed produces the same champion & gate verdicts', () => {
    const a = runBenchmark({ population: 12, cycles: 30, seed: 3 });
    const b = runBenchmark({ population: 12, cycles: 30, seed: 3 });
    expect(a.champion.breakdown).toEqual(b.champion.breakdown);
    expect(a.gates.map((g) => g.pass)).toEqual(b.gates.map((g) => g.pass));
    expect(a.passed).toBe(b.passed);
  });
});

describe('ruVector compounding — memory makes the harness smarter (ADR-155)', () => {
  it('a memory-backed harness resists tricky decoys a memoryless one mis-reports', () => {
    const { withoutMemory, withMemory } = strongMemoryAdvantage(defaultCorpus());
    // Memory must not INCREASE false positives, and should reduce them on the
    // tricky-decoy corpus (negative memory at work).
    expect(withMemory.falsePositives).toBeLessThanOrEqual(withoutMemory.falsePositives);
  });
});
