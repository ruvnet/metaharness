// SPDX-License-Identifier: MIT
//
// The ruv-fann-backed surrogate, against the real WASM runtime (ruv-fann is a
// devDependency here; it is an optional peer for consumers).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFannSurrogate, fannEpochBudget, type FannSurrogate } from '../src/fann-surrogate.js';
import { evolveNumeric } from '../src/numeric-evolve.js';
import { spearman, type SurrogateRow } from '../src/numeric-surrogate.js';
import type { NumericEvaluator, NumericGenome, NumericGenomeSpec, NumericScoreCard } from '../src/numeric-types.js';

/** Deterministic [0,1) stream for synthetic data. */
function stream(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** A smooth, non-linear 3-parameter objective peaking at (0.7, 0.3, 0.5). */
const truth = (f: readonly number[]): number => -((f[0] - 0.7) ** 2) - 2 * (f[1] - 0.3) ** 2 - 0.5 * (f[2] - 0.5) ** 2;

function sample(n: number, seed: number): SurrogateRow[] {
  const rand = stream(seed);
  return Array.from({ length: n }, () => {
    const features = [rand(), rand(), rand()];
    return { features, target: truth(features) };
  });
}

const open: FannSurrogate[] = [];
async function surrogate(options: Parameters<typeof createFannSurrogate>[0] = {}): Promise<FannSurrogate> {
  const s = await createFannSurrogate(options);
  open.push(s);
  return s;
}
const dirs: string[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) s.dispose();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('FannSurrogate', () => {
  const train = sample(60, 1);
  const test = sample(200, 2);
  const heldOutRho = (s: FannSurrogate): number => spearman(s.predict(test.map((r) => r.features)), test.map((r) => r.target));

  it('learns to rank unseen genomes from 60 rows', async () => {
    const s = await surrogate();
    expect(await s.fit(train)).toBe(true);
    expect(s.lastFit!.finalLoss).toBeLessThan(s.lastFit!.initialLoss);
    expect(s.lastFit).toMatchObject({ rows: 60, epochs: 300, members: 1 });
    expect(heldOutRho(s)).toBeGreaterThan(0.8);
  });

  it('is deterministic: same rows and seed give identical predictions, with and without SIMD', async () => {
    const a = await surrogate({ seed: 3 });
    const b = await surrogate({ seed: 3, simd: false });
    await a.fit(train);
    await b.fit(train);
    // loadRuntime caches per backend; make sure these really are two backends
    // (skipped on a host without WebAssembly SIMD, where both are 'wasm').
    expect(b.lastFit!.backend).toBe('wasm');
    if (a.lastFit!.backend !== 'wasm') expect(a.lastFit!.backend).toBe('wasm-simd');
    const features = test.slice(0, 50).map((r) => r.features);
    expect(b.predict(features)).toEqual(a.predict(features));
    const c = await surrogate({ seed: 4 });
    await c.fit(train);
    expect(c.predict(features)).not.toEqual(a.predict(features));
  });

  it('predicts on the original target scale', async () => {
    const s = await surrogate();
    const shifted = train.map((r) => ({ features: r.features, target: 1000 + 50 * r.target }));
    await s.fit(shifted);
    const predictions = s.predict(shifted.map((r) => r.features));
    const mean = predictions.reduce((p, q) => p + q, 0) / predictions.length;
    const targetMean = shifted.reduce((p, q) => p + q.target, 0) / shifted.length;
    expect(Math.abs(mean - targetMean)).toBeLessThan(5);
  });

  it('supports deeper shapes, other activations, SGD, rank targets and ensembles', async () => {
    for (const options of [
      { hidden: [16, 8] },
      { activation: 'Sigmoid', learningRate: 0.05 },
      { optimizer: 'sgd', learningRate: 0.05, epochs: 600 },
      { targetTransform: 'rank' },
      { ensemble: 4, explorationWeight: 0.5 },
    ] as const) {
      const s = await surrogate(options);
      expect(await s.fit(train), JSON.stringify(options)).toBe(true);
      expect(heldOutRho(s), JSON.stringify(options)).toBeGreaterThan(0.6);
    }
  });

  it('rank targets ignore an outlier that wrecks the scale', async () => {
    const withOutlier = [...train, { features: [0.05, 0.95, 0.5], target: -1e6 }];
    const s = await surrogate({ targetTransform: 'rank' });
    expect(await s.fit(withOutlier)).toBe(true);
    expect(heldOutRho(s)).toBeGreaterThan(0.7);
    for (const p of s.predict(test.slice(0, 20).map((r) => r.features))) expect(p).toBeGreaterThan(-2);
  });

  it('an exploration weight changes the ranking only through ensemble disagreement', async () => {
    const plain = await surrogate({ ensemble: 3 });
    const bold = await surrogate({ ensemble: 3, explorationWeight: 2 });
    await plain.fit(train);
    await bold.fit(train);
    const features = test.slice(0, 40).map((r) => r.features);
    const p = plain.predict(features);
    const q = bold.predict(features);
    for (let i = 0; i < p.length; i++) expect(q[i]).toBeGreaterThanOrEqual(p[i]);
    expect(q).not.toEqual(p);
  });

  it('declines constant targets and too few rows, and refuses to predict unfitted', async () => {
    const s = await surrogate();
    expect(await s.fit(train.map((r) => ({ ...r, target: 1 })))).toBe(false);
    expect(await s.fit(train.slice(0, 1))).toBe(false);
    expect(() => s.predict([[0, 0, 0]])).toThrow(/no fitted model/);
  });

  it('caps epochs to ruv-fann’s work budget and trains only the most recent maxRows', async () => {
    const s = await surrogate({ hidden: [64, 64], epochs: 1000, maxRows: 40 });
    expect(await s.fit(sample(300, 5))).toBe(true);
    expect(s.lastFit!.rows).toBe(40);
    expect(s.lastFit!.epochs).toBe(fannEpochBudget(40, 3, [64, 64], 100_000_000));
    expect(s.lastFit!.epochs).toBeLessThan(1000);
  });

  it('rejects bad options and mismatched feature lengths', async () => {
    await expect(createFannSurrogate({ ensemble: 0 })).rejects.toThrow(/ensemble/);
    await expect(createFannSurrogate({ hidden: [] })).rejects.toThrow(/hidden/);
    await expect(createFannSurrogate({ learningRate: -1 })).rejects.toThrow(/learningRate/);
    const s = await surrogate();
    await s.fit(train);
    expect(() => s.predict([[0.1, 0.2]])).toThrow(/feature length/);
  });

  it('drives evolveNumeric end to end and is reproducible', async () => {
    const spec: NumericGenomeSpec = {
      a: { min: 0, max: 1, scale: 'linear', type: 'float', default: 0.1 },
      b: { min: 0, max: 1, scale: 'linear', type: 'float', default: 0.9 },
      c: { min: 0, max: 1, scale: 'linear', type: 'float', default: 0.1 },
    };
    const evaluator: NumericEvaluator = {
      async evaluate(genome: NumericGenome, variantId: string): Promise<NumericScoreCard> {
        return { variantId, primary: truth([genome.a, genome.b, genome.c]), regressed: false, noopRate: 0, costPerWin: 0 };
      },
    };
    const run = async () => {
      const dir = await mkdtemp(join(tmpdir(), 'darwin-fann-'));
      dirs.push(dir);
      return evolveNumeric({
        genomeSpec: spec,
        evaluator,
        generations: 8,
        childrenPerGeneration: 4,
        seed: 11,
        workRoot: dir,
        surrogate: { model: await surrogate({ seed: 11 }), minRows: 8, trust: { minSpearman: 0 } },
      });
    };
    const first = await run();
    const second = await run();
    expect(first.surrogate!.generationsScreened).toBeGreaterThan(0);
    expect(first.winner!.score!.primary).toBeGreaterThan(first.baseline.score!.primary);
    expect(second.records.map((r) => [r.variant.id, r.variant.genome])).toEqual(first.records.map((r) => [r.variant.id, r.variant.genome]));
  });
});
