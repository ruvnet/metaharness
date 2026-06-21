// SPDX-License-Identifier: MIT
//
// Real-CVE-shaped benchmark (ADR-155 Addendum A, Phase 2). An 8-CWE corpus with
// pre-fix/post-fix PAIRS: a detector that fires on the patched twin is a false
// positive, so the fitness landscape rewards real precision. Evolution is driven
// by REAL semgrep; tests skipIf(!available). The evolution result is memoized so
// all assertions share a single (deterministic) run.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evolveDetectorsReal, FULL_VOCABULARY, type RealEvolveResult } from '../../src/security/real-evolve.js';
import { SemgrepDetectorOracle, type TargetLabel } from '../../src/security/semgrep-oracle.js';

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bench', 'security', 'fixtures', 'cwe-bench');
const labels: TargetLabel[] = JSON.parse(readFileSync(join(corpusDir, 'labels.json'), 'utf8')).labels;
const corpus = { dir: corpusDir, labels };
const available = new SemgrepDetectorOracle().isAvailable();

let memo: RealEvolveResult | undefined;
const run = (): RealEvolveResult => {
  if (!memo) memo = evolveDetectorsReal({ corpus, generations: 10, population: 8, seed: 0, baseline: ['eval'], vocabulary: FULL_VOCABULARY });
  return memo;
};

describe('cwe-bench corpus shape (always runs)', () => {
  it('has 8 pre-fix/post-fix pairs + decoys', () => {
    expect(labels.filter((l) => l.vulnerable).length).toBe(8);
    expect((labels as Array<{ fixed?: boolean }>).filter((l) => l.fixed).length).toBe(8);
    expect(FULL_VOCABULARY.length).toBe(8);
  });
});

describe.skipIf(!available)('real semgrep-driven evolution on the real-CVE-shaped benchmark', () => {
  it('evolves the full 8-weakness detector with zero false positives on patched twins', { timeout: 300_000 }, () => {
    const r = run();
    expect(r.available).toBe(true);
    expect(r.champion.mean).toBe(1);
    expect([...r.champion.patterns].sort()).toEqual([...FULL_VOCABULARY].sort());
    expect(r.champion.falsePositives).toBe(0); // never fires on a patched twin or decoy
  });

  it('beats the weak baseline, bootstrap-certified', { timeout: 300_000 }, () => {
    const r = run();
    expect(r.baseline.mean).toBeLessThan(r.champion.mean);
    expect(r.promotedOverBaseline).toBe(true);
    expect(r.bootstrapVsBaseline.lower95).toBeGreaterThan(0);
  });

  it('climbs monotonically to the optimum (evolution, not lucky init)', { timeout: 300_000 }, () => {
    const r = run();
    expect(r.history[0]).toBeLessThan(1);
    expect(r.history[r.history.length - 1]).toBe(1);
    for (let i = 1; i < r.history.length; i += 1) expect(r.history[i]).toBeGreaterThanOrEqual(r.history[i - 1]);
  });

  it('caches fitness and is deterministic', { timeout: 300_000 }, () => {
    const r = run();
    expect(r.oracleCalls).toBeLessThan(r.evaluations);
    const again = evolveDetectorsReal({ corpus, generations: 10, population: 8, seed: 0, baseline: ['eval'], vocabulary: FULL_VOCABULARY });
    expect(again.receiptHash).toBe(r.receiptHash);
  });
});
