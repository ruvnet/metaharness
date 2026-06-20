// SPDX-License-Identifier: MIT
//
// Darwin Shield REAL evolutionary loop (ADR-155 Addendum A, Phase 2 §capstone):
// a detector population evolved with REAL semgrep as the fitness oracle. Real-tool
// parts skipIf(!available); the graceful-skip + vocabulary checks always run.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_PATTERNS, evolveDetectorsReal } from '../../src/security/real-evolve.js';
import { SemgrepDetectorOracle, type TargetLabel } from '../../src/security/semgrep-oracle.js';

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bench', 'security', 'fixtures', 'semgrep-corpus');
const labels: TargetLabel[] = JSON.parse(readFileSync(join(corpusDir, 'labels.json'), 'utf8')).labels;
const corpus = { dir: corpusDir, labels };
const available = new SemgrepDetectorOracle().isAvailable();

describe('real-evolve vocabulary + graceful skip (always run)', () => {
  it('exposes the full weakness vocabulary', () => {
    expect(ALL_PATTERNS).toContain('eval');
    expect(ALL_PATTERNS.length).toBe(5);
  });
  it('returns available:false for an absent semgrep, never throws', () => {
    const r = evolveDetectorsReal({ corpus, generations: 3, population: 4, seed: 5, oracle: new SemgrepDetectorOracle({ binary: '/nonexistent/semgrep' }) });
    expect(r.available).toBe(false);
    expect(r.promotedOverBaseline).toBe(false);
  });
});

describe.skipIf(!available)('real semgrep-driven evolution', () => {
  const run = () => evolveDetectorsReal({ corpus, generations: 6, population: 6, seed: 5, baseline: ['eval'] });

  it('evolves a champion that dominates the baseline (bootstrap-certified, zero FP)', { timeout: 180_000 }, () => {
    const r = run();
    expect(r.available).toBe(true);
    expect(r.champion.mean).toBeGreaterThan(r.baseline.mean);
    expect(r.champion.falsePositives).toBe(0);
    expect(r.promotedOverBaseline).toBe(true);
    expect(r.bootstrapVsBaseline.lower95).toBeGreaterThan(0);
  });

  it('the champion discovers the full weakness set', { timeout: 180_000 }, () => {
    const r = run();
    expect([...r.champion.patterns].sort()).toEqual([...ALL_PATTERNS].sort());
    expect(r.champion.mean).toBe(1);
  });

  it('the learning curve climbs (evolution, not lucky init)', { timeout: 180_000 }, () => {
    const r = run();
    expect(r.history[0]).toBeLessThan(r.history[r.history.length - 1]); // strictly improved
    for (let i = 1; i < r.history.length; i += 1) expect(r.history[i]).toBeGreaterThanOrEqual(r.history[i - 1]); // monotone champion
  });

  it('caches fitness (fewer real semgrep calls than evaluations) and is deterministic', { timeout: 180_000 }, () => {
    const a = run();
    const b = run();
    expect(a.oracleCalls).toBeLessThan(a.evaluations);
    expect(a.receiptHash).toBe(b.receiptHash);
    expect(a.history).toEqual(b.history);
  });
});
