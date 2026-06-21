// SPDX-License-Identifier: MIT
//
// Darwin Shield Invariant Genome (ADR-155 Addendum B). The loop: assert security
// invariants → a (mock) fuzzer tries to falsify them → a violated invariant
// becomes a finding → the finding becomes a durable detector. Trust property:
// clean code and decoys yield NO counterexample, so false positives are ~0.

import { describe, expect, it } from 'vitest';
import {
  INVARIANT_KINDS,
  MockFuzzOracle,
  baselineInvariantGenome,
  evolveInvariants,
  falsificationToDetector,
  generateInvariants,
  isInvariantGenomeValid,
  kindForWeakness,
  mutateInvariant,
  runInvariantHarness,
} from '../../src/security/invariant.js';
import { validateGeneratedShieldCode } from '../../src/security/selfwrite.js';
import { defaultCorpus, groundTruth, decoys } from '../../src/security/corpus.js';
import { hardCorpus } from '../../src/security/ablation.js';
import { makeRng } from '../../src/security/util.js';

const fuzz = new MockFuzzOracle();
const easy = defaultCorpus();
const hard = hardCorpus();

describe('kindForWeakness — weakness ↦ invariant class', () => {
  it('maps representative CWEs to the right assertion kind', () => {
    expect(kindForWeakness('CWE-89 SQL injection')).toBe('taint-flow');
    expect(kindForWeakness('CWE-502 unsafe deserialization')).toBe('serialization');
    expect(kindForWeakness('CWE-287 auth bypass')).toBe('auth-boundary');
    expect(kindForWeakness('CWE-416 use-after-free')).toBe('memory-safety');
    expect(kindForWeakness('CWE-22 path traversal')).toBe('path-traversal');
  });
});

describe('MockFuzzOracle — falsification requires a real counterexample', () => {
  it('falsifies a matching-kind invariant on a genuine vulnerability', () => {
    const vuln = groundTruth(easy).find((s) => kindForWeakness(s.weakness) === 'taint-flow')!;
    const inv = generateInvariants({ ...baselineInvariantGenome(), kinds: ['taint-flow'], strength: 0.99, fuzzBudgetSeconds: 600 }, vuln)[0];
    expect(fuzz.attempt(inv, vuln, 600)).not.toBeNull();
  });

  it('NEVER falsifies on clean code / decoys (zero false positives)', () => {
    for (const d of decoys(easy)) {
      for (const kind of INVARIANT_KINDS) {
        const inv = generateInvariants({ ...baselineInvariantGenome(), kinds: [kind], strength: 0.99, fuzzBudgetSeconds: 600 }, d)[0];
        expect(fuzz.attempt(inv, d, 600)).toBeNull();
      }
    }
  });

  it('does not falsify with the wrong invariant kind', () => {
    const vuln = groundTruth(easy).find((s) => kindForWeakness(s.weakness) === 'taint-flow')!;
    const wrong = generateInvariants({ ...baselineInvariantGenome(), kinds: ['race-condition'], strength: 0.99, fuzzBudgetSeconds: 600 }, vuln)[0];
    expect(fuzz.attempt(wrong, vuln, 600)).toBeNull();
  });
});

describe('runInvariantHarness — findings from falsifications', () => {
  it('a strong, broad genome finds vulnerabilities with zero false positives', () => {
    const strong = { ...baselineInvariantGenome(), kinds: [...INVARIANT_KINDS], strength: 0.99, fuzzBudgetSeconds: 600 };
    const r = runInvariantHarness(strong, easy, fuzz, 0.6);
    expect(r.metrics.truePositives).toBeGreaterThan(0);
    expect(r.metrics.falsePositives).toBe(0);
    expect(r.findings.every((f) => f.exploitCodeAllowed === false)).toBe(true);
  });

  it('is deterministic', () => {
    const g = { ...baselineInvariantGenome(), kinds: [...INVARIANT_KINDS], strength: 0.9, fuzzBudgetSeconds: 300 };
    expect(runInvariantHarness(g, easy, fuzz, 0.6).metrics).toEqual(runInvariantHarness(g, easy, fuzz, 0.6).metrics);
  });
});

describe('mutateInvariant — bounded + valid', () => {
  it('stays inside the envelope across many mutations', () => {
    const rng = makeRng(0);
    let g = baselineInvariantGenome();
    for (let i = 0; i < 200; i += 1) {
      g = mutateInvariant(g, rng, 1, i);
      expect(isInvariantGenomeValid(g)).toBe(true);
    }
  });
});

describe('evolveInvariants — statistically superior, zero FP', () => {
  it('the evolved champion beats the baseline (lower95 > 0) on the easy corpus', () => {
    const r = evolveInvariants(easy, fuzz, { population: 12, cycles: 30, seed: 0, baselineFalsePositiveRate: 0.6 });
    expect(r.champion.breakdown.fitness).toBeGreaterThan(r.baseline.breakdown.fitness);
    expect(r.promote).toBe(true);
    expect(r.lower95).toBeGreaterThan(0);
    expect(r.champion.metrics.falsePositives).toBe(0);
  });

  it('fuzzing beats static rules on the hard corpus (finds the subtle bugs)', () => {
    const r = evolveInvariants(hard, fuzz, { population: 12, cycles: 30, seed: 0, baselineFalsePositiveRate: 0.6 });
    // The config/static-rule champion tops out at TPR ~0.6 on the hard corpus;
    // invariant+fuzz reaches every hard vuln with zero false positives.
    expect(r.champion.metrics.truePositives).toBe(groundTruth(hard).length);
    expect(r.champion.metrics.falsePositives).toBe(0);
    expect(r.promote).toBe(true);
  });

  it('is deterministic', () => {
    const a = evolveInvariants(easy, fuzz, { population: 10, cycles: 20, seed: 5 });
    const b = evolveInvariants(easy, fuzz, { population: 10, cycles: 20, seed: 5 });
    expect(a.champion.breakdown).toEqual(b.champion.breakdown);
    expect(a.history).toEqual(b.history);
  });
});

describe('falsificationToDetector — durable detector from a violated invariant', () => {
  it('produces a valid, safe detector artifact that passes the self-writing gate', () => {
    const r = evolveInvariants(easy, fuzz, { population: 12, cycles: 30, seed: 0, baselineFalsePositiveRate: 0.6 });
    expect(r.champion.falsifications.length).toBeGreaterThan(0);
    const det = falsificationToDetector(r.champion.falsifications[0]);
    expect(det.surface).toBe('taint-heuristic');
    expect(validateGeneratedShieldCode(det.surface, det.artifact)).toEqual([]);
  });
});
