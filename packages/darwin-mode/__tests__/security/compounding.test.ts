// SPDX-License-Identifier: MIT
//
// Darwin Shield compounding acceptance (ADR-155 §advanced ruVector integration
// §acceptance test). The "beyond SOTA" moat: the system gets smarter across runs.
// Each metric is a controlled A/B (same harness/corpus, with vs without prior
// memory) and must clear the published threshold.

import { describe, expect, it } from 'vitest';
import {
  falsePositiveRepeatDrop,
  measureCompounding,
  patchReuseSuccess,
  seededVsRandom,
} from '../../src/security/compounding.js';
import { defaultCorpus } from '../../src/security/corpus.js';

const corpus = defaultCorpus();

describe('false-positive repeat-rate drop ≥ 35% (negative memory)', () => {
  it('warm (memory-backed) run leaks fewer tricky decoys than cold', () => {
    const r = falsePositiveRepeatDrop();
    expect(r.cold).toBeGreaterThan(0);
    expect(r.warm).toBeLessThan(r.cold);
    expect(r.drop).toBeGreaterThanOrEqual(0.35);
  });

  it('is deterministic', () => {
    expect(falsePositiveRepeatDrop()).toEqual(falsePositiveRepeatDrop());
  });
});

describe('patch-reuse improvement ≥ 20% (patch memory)', () => {
  it('a warm run reuses accepted patches for recurring weakness classes', () => {
    const r = patchReuseSuccess(corpus);
    expect(r.withoutMemory).toBe(0);
    expect(r.withMemory).toBeGreaterThan(0);
    expect(r.improvement).toBeGreaterThanOrEqual(0.2);
  });
});

describe('seeded genomes beat random ≥ 15% (genome memory)', () => {
  it('a genome-seeded population starts at higher mean fitness than random', () => {
    const r = seededVsRandom(corpus, 0.5, 0);
    expect(r.seededMean).toBeGreaterThan(r.randomMean);
    expect(r.advantage).toBeGreaterThanOrEqual(0.15);
  });

  it('is deterministic for a fixed seed', () => {
    expect(seededVsRandom(corpus, 0.5, 3)).toEqual(seededVsRandom(corpus, 0.5, 3));
  });
});

describe('measureCompounding — full acceptance', () => {
  it('passes every ADR-155 ruVector acceptance metric', () => {
    const r = measureCompounding(corpus, 0.5, 0);
    expect(r.fpRepeatDrop.pass).toBe(true);
    expect(r.patchReuse.pass).toBe(true);
    expect(r.seededVsRandom.pass).toBe(true);
    expect(r.passed).toBe(true);
  });
});
