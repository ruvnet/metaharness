// SPDX-License-Identifier: MIT
//
// Tests for the numeric genome kind (ADR-272): bounds/scale-respecting
// mutation, crossover, and a full evolveNumeric loop converging toward a known
// optimum via a synthetic in-process evaluator (no subprocess/SSH — that path
// is exercised separately, out of this fast unit suite).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crossoverGenome, defaultGenome, mutateGenome } from '../src/numeric-mutator.js';
import { evolveNumeric } from '../src/numeric-evolve.js';
import { NumericArchive } from '../src/numeric-archive.js';
import type { NumericEvaluator, NumericGenome, NumericGenomeSpec, NumericScoreCard } from '../src/numeric-types.js';

const SPEC: NumericGenomeSpec = {
  learning_rate: { min: 1e-5, max: 1e-1, scale: 'log', type: 'float' },
  epochs: { min: 1, max: 300, scale: 'linear', type: 'int' },
  batch_size: { min: 1, max: 64, scale: 'log', type: 'int' },
};

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'darwin-numeric-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('defaultGenome', () => {
  it('places every parameter at its bounds midpoint (or explicit default) and respects int rounding', () => {
    const g = defaultGenome(SPEC);
    expect(g.epochs).toBe(Math.round((1 + 300) / 2));
    // log-scale midpoint is the geometric mean, not the arithmetic mean.
    expect(g.learning_rate).toBeCloseTo(Math.sqrt(1e-5 * 1e-1), 6);
    expect(Number.isInteger(g.batch_size)).toBe(true);
  });

  it('uses an explicit `default` when supplied instead of the midpoint', () => {
    const spec: NumericGenomeSpec = { x: { min: 0, max: 10, scale: 'linear', type: 'float', default: 3 } };
    expect(defaultGenome(spec).x).toBe(3);
  });
});

describe('mutateGenome', () => {
  it('never produces a value outside [min, max] across many seeds/generations', () => {
    const base = defaultGenome(SPEC);
    for (let seed = 0; seed < 25; seed++) {
      for (let gen = 1; gen <= 3; gen++) {
        const { genome } = mutateGenome(base, SPEC, seed, gen, 0, 0.5);
        for (const [name, spec] of Object.entries(SPEC)) {
          expect(genome[name]).toBeGreaterThanOrEqual(spec.min);
          expect(genome[name]).toBeLessThanOrEqual(spec.max);
        }
      }
    }
  });

  it('keeps int-typed parameters integral', () => {
    const base = defaultGenome(SPEC);
    const { genome } = mutateGenome(base, SPEC, 1, 1, 0, 0.5);
    expect(Number.isInteger(genome.epochs)).toBe(true);
    expect(Number.isInteger(genome.batch_size)).toBe(true);
  });

  it('is deterministic: same seed/generation/index/sigma ⇒ identical child', () => {
    const base = defaultGenome(SPEC);
    const a = mutateGenome(base, SPEC, 7, 2, 3, 0.2);
    const b = mutateGenome(base, SPEC, 7, 2, 3, 0.2);
    expect(a).toEqual(b);
  });

  it('produces a different genome for a different seed (sanity: not a constant no-op)', () => {
    const base = defaultGenome(SPEC);
    const a = mutateGenome(base, SPEC, 1, 1, 0, 0.3);
    const b = mutateGenome(base, SPEC, 2, 1, 0, 0.3);
    expect(a.genome).not.toEqual(b.genome);
  });

  it('always changes at least one parameter (never a silent full no-op)', () => {
    const base = defaultGenome(SPEC);
    for (let seed = 0; seed < 10; seed++) {
      const { mutatedParams } = mutateGenome(base, SPEC, seed, 1, 0, 0.2);
      expect(mutatedParams.length).toBeGreaterThan(0);
    }
  });
});

describe('crossoverGenome', () => {
  it('adopts a proper, non-empty subset of parameters from parent B', () => {
    const a = defaultGenome(SPEC);
    const b: NumericGenome = { learning_rate: 0.05, epochs: 10, batch_size: 8 };
    const { genome, fromB } = crossoverGenome(a, b, SPEC, 0, 1, 0);
    expect(fromB.length).toBeGreaterThan(0);
    expect(fromB.length).toBeLessThan(Object.keys(SPEC).length);
    for (const name of fromB) expect(genome[name]).toBe(b[name]);
    for (const name of Object.keys(SPEC).filter((n) => !fromB.includes(n))) expect(genome[name]).toBe(a[name]);
  });
});

/** A synthetic evaluator with a known optimum: minimizes distance from a target genome. */
class DistanceEvaluator implements NumericEvaluator {
  calls = 0;
  constructor(private readonly target: NumericGenome) {}
  async evaluate(genome: NumericGenome): Promise<NumericScoreCard> {
    this.calls++;
    let sse = 0;
    for (const [name, value] of Object.entries(this.target)) {
      const span = Math.max(Math.abs(value), 1);
      sse += ((genome[name] - value) / span) ** 2;
    }
    return { variantId: 'n/a', primary: -sse, regressed: false, noopRate: 0, costPerWin: 1, raw: { sse } };
  }
}

describe('evolveNumeric', () => {
  it('improves over the baseline toward a known optimum given enough generations', async () => {
    const workRoot = await tmpDir();
    const target: NumericGenome = { learning_rate: 0.01, epochs: 200, batch_size: 16 };
    const evaluator = new DistanceEvaluator(target);
    const result = await evolveNumeric({
      genomeSpec: SPEC,
      evaluator,
      generations: 6,
      childrenPerGeneration: 6,
      seed: 42,
      mutationSigma: 0.35,
      workRoot,
    });

    expect(result.winner).not.toBeNull();
    const baselinePrimary = result.baseline.score!.primary;
    const winnerPrimary = result.winner!.score!.primary;
    expect(winnerPrimary).toBeGreaterThan(baselinePrimary);
    // The winner's lineage must be a valid parent chain rooted at the baseline.
    expect(result.winnerLineage[0]).toBe(result.baseline.variant.id);
    expect(result.winnerLineage[result.winnerLineage.length - 1]).toBe(result.winner!.variant.id);
    // Distinct genomes were actually tried, not one value repeated.
    const distinctGenomeStrings = new Set(result.records.map((r) => JSON.stringify(r.variant.genome)));
    expect(distinctGenomeStrings.size).toBeGreaterThan(1);
  });

  it('is reproducible: two runs with the same seed produce the same winner genome', async () => {
    const target: NumericGenome = { learning_rate: 0.02, epochs: 50, batch_size: 32 };
    const runOnce = async () => {
      const workRoot = await tmpDir();
      return evolveNumeric({
        genomeSpec: SPEC,
        evaluator: new DistanceEvaluator(target),
        generations: 3,
        childrenPerGeneration: 4,
        seed: 11,
        workRoot,
      });
    };
    const [a, b] = await Promise.all([runOnce(), runOnce()]);
    expect(a.winner!.variant.genome).toEqual(b.winner!.variant.genome);
    expect(a.winner!.score!.primary).toBeCloseTo(b.winner!.score!.primary, 10);
  });

  it('persists an archive.json that reloads to the same records (round-trip)', async () => {
    const workRoot = await tmpDir();
    await evolveNumeric({
      genomeSpec: SPEC,
      evaluator: new DistanceEvaluator({ learning_rate: 0.03, epochs: 100, batch_size: 8 }),
      generations: 2,
      childrenPerGeneration: 3,
      seed: 5,
      workRoot,
    });
    const reloaded = new NumericArchive(join(workRoot, 'archive.json'));
    await reloaded.load();
    expect(reloaded.all().length).toBeGreaterThan(0);
    expect(reloaded.best()).not.toBeNull();
  });

  it('demotes a candidate whose evaluator reports regressed=true instead of crashing', async () => {
    const workRoot = await tmpDir();
    let n = 0;
    const flaky: NumericEvaluator = {
      async evaluate(): Promise<NumericScoreCard> {
        n++;
        // Every child regresses; only the baseline (call #1) is healthy.
        const regressed = n > 1;
        return { variantId: 'n/a', primary: regressed ? -1 : 0, regressed, noopRate: 0, costPerWin: 1 };
      },
    };
    const result = await evolveNumeric({
      genomeSpec: SPEC,
      evaluator: flaky,
      generations: 2,
      childrenPerGeneration: 2,
      seed: 0,
      workRoot,
    });
    // Baseline stays the winner since every child was regressed/worse.
    expect(result.winner!.variant.id).toBe(result.baseline.variant.id);
  });
});
