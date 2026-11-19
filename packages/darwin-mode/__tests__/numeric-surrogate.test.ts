// SPDX-License-Identifier: MIT
//
// Surrogate pre-screening for the numeric genome kind: the pure selection and
// row-assembly logic, the evolveNumeric wiring (driven by a fake surrogate, so
// no model is involved), and the fail-open and opt-out guarantees.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evolveNumeric } from '../src/numeric-evolve.js';
import { genomeToUnitVector } from '../src/numeric-mutator.js';
import {
  fitSurrogate,
  selectByPrediction,
  spearman,
  surrogateRowsFromArchive,
  validateSurrogateConfig,
  type NumericSurrogate,
  type NumericSurrogateEvent,
  type SurrogateRow,
} from '../src/numeric-surrogate.js';
import type { NumericArchiveRecord, NumericEvaluator, NumericGenome, NumericGenomeSpec, NumericScoreCard } from '../src/numeric-types.js';

const SPEC: NumericGenomeSpec = {
  x: { min: 0, max: 1, scale: 'linear', type: 'float' },
  y: { min: 0, max: 1, scale: 'linear', type: 'float' },
};

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'darwin-surrogate-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** primary = x (so "larger x is better"), counting calls. */
class XEvaluator implements NumericEvaluator {
  calls: string[] = [];
  async evaluate(genome: NumericGenome, variantId: string): Promise<NumericScoreCard> {
    this.calls.push(variantId);
    return { variantId, primary: genome.x, regressed: false, noopRate: 0, costPerWin: 0 };
  }
}

/** A surrogate that knows the truth (predicts feature 0), recording how it was used. */
class OracleSurrogate implements NumericSurrogate {
  fits: number[] = [];
  predicted = 0;
  constructor(private readonly behaviour: { decline?: boolean; throwOnFit?: boolean; throwOnPredict?: boolean; sign?: number } = {}) {}
  async fit(rows: readonly SurrogateRow[]): Promise<boolean> {
    if (this.behaviour.throwOnFit) throw new Error('fit exploded');
    this.fits.push(rows.length);
    return !this.behaviour.decline;
  }
  predict(features: readonly (readonly number[])[]): number[] {
    if (this.behaviour.throwOnPredict) throw new Error('predict exploded');
    this.predicted += features.length;
    return features.map((f) => (this.behaviour.sign ?? 1) * f[0]);
  }
}

const record = (id: string, genome: NumericGenome, score: Partial<NumericScoreCard> | null): NumericArchiveRecord => ({
  variant: { id, parentId: null, generation: 0, genome, mutatedParams: [], mutationSummary: '', createdAt: '' },
  score: score === null ? null : { variantId: id, primary: 0, regressed: false, noopRate: 0, costPerWin: 0, ...score },
  children: [],
});

describe('genomeToUnitVector', () => {
  it('encodes in spec key order, log parameters in log space, missing as the midpoint', () => {
    const spec: NumericGenomeSpec = {
      lr: { min: 1e-4, max: 1e-2, scale: 'log', type: 'float' },
      n: { min: 0, max: 10, scale: 'linear', type: 'int' },
      absent: { min: 0, max: 1, scale: 'linear', type: 'float' },
    };
    const v = genomeToUnitVector({ n: 5, lr: 1e-3 }, spec);
    expect(v[0]).toBeCloseTo(0.5, 9);
    expect(v[1]).toBeCloseTo(0.5, 9);
    expect(v[2]).toBe(0.5);
  });
});

describe('surrogateRowsFromArchive', () => {
  it('drops unscored and errored records and floors regressed targets to the worst healthy primary', () => {
    const rows = surrogateRowsFromArchive(
      [
        record('a', { x: 0.1, y: 0 }, { primary: 0.2 }),
        record('b', { x: 0.9, y: 0 }, { primary: 0.7 }),
        record('c', { x: 0.5, y: 0 }, { primary: 0.95, regressed: true }),
        record('d', { x: 0.3, y: 0 }, null),
        record('e', { x: 0.4, y: 0 }, { primary: 0, evaluatorError: 'boom' }),
        record('f', { x: 0.4, y: 0 }, { primary: Number.NaN }),
      ],
      SPEC,
    );
    expect(rows.map((r) => r.target)).toEqual([0.2, 0.7, 0.2]);
    expect(rows[1].features).toEqual([0.9, 0]);
  });
});

describe('selectByPrediction', () => {
  it('keeps the explore slots, then fills by prediction, returning picks in pool order', () => {
    const picks = selectByPrediction([0.1, 0.9, 0.5, 0.8, 0.2], 3, 1);
    expect(picks.map((p) => p.poolIndex)).toEqual([0, 1, 3]);
    expect(picks.map((p) => p.kind)).toEqual(['explore', 'predicted', 'predicted']);
    expect(picks.map((p) => p.rank)).toEqual([5, 1, 2]);
  });

  it('breaks ties and non-finite predictions toward pool order', () => {
    expect(selectByPrediction([1, 1, 1, 1], 2, 0).map((p) => p.poolIndex)).toEqual([0, 1]);
    expect(selectByPrediction([Number.NaN, 0.5, Number.NaN], 1, 0).map((p) => p.poolIndex)).toEqual([1]);
  });

  it('never returns more than the pool or the slots', () => {
    expect(selectByPrediction([3, 2], 5, 4)).toHaveLength(2);
    expect(selectByPrediction([3, 2, 1], 0, 1)).toHaveLength(0);
  });
});

describe('spearman', () => {
  it('is 1 for monotone agreement, -1 for reversal, 0 for a constant side', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 25, 99])).toBeCloseTo(1, 9);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 9);
    expect(spearman([1, 2, 3], [5, 5, 5])).toBe(0);
  });
});

describe('fitSurrogate', () => {
  const rows: SurrogateRow[] = Array.from({ length: 20 }, (_, i) => ({ features: [i / 19, 0], target: i / 19 }));

  it('passes the trust gate for a model that ranks the holdout well, and refits on all rows', async () => {
    const model = new OracleSurrogate();
    const outcome = await fitSurrogate(model, rows, { minSpearman: 0.5 });
    expect(outcome).toEqual({ ready: true, holdoutSpearman: 1 });
    expect(model.fits).toEqual([15, 20]); // training split, then everything
  });

  it('fails the trust gate for an anti-correlated model', async () => {
    const outcome = await fitSurrogate(new OracleSurrogate({ sign: -1 }), rows, { minSpearman: 0.2 });
    expect(outcome.ready).toBe(false);
    expect(outcome.ready === false && outcome.reason).toMatch(/held-out Spearman -1\.000 < 0\.2/);
  });

  it('turns a declined fit and a thrown error into a reason instead of throwing', async () => {
    expect(await fitSurrogate(new OracleSurrogate({ decline: true }), rows)).toEqual({ ready: false, reason: 'surrogate declined to fit' });
    expect(await fitSurrogate(new OracleSurrogate({ throwOnFit: true }), rows)).toEqual({ ready: false, reason: 'surrogate error: fit exploded' });
  });
});

describe('validateSurrogateConfig', () => {
  it('rejects out-of-range settings', () => {
    const model = new OracleSurrogate();
    expect(() => validateSurrogateConfig({ model, oversample: 1 })).toThrow(/oversample/);
    expect(() => validateSurrogateConfig({ model, refitEvery: 0 })).toThrow(/refitEvery/);
    expect(() => validateSurrogateConfig({ model, exploreSlots: 1.5 })).toThrow(/exploreSlots/);
    expect(() => validateSurrogateConfig({ model, trust: { minSpearman: 2 } })).toThrow(/minSpearman/);
    expect(() => validateSurrogateConfig({ model, trust: { minSpearman: 0, holdoutFraction: 0.9 } })).toThrow(/holdoutFraction/);
    expect(() => validateSurrogateConfig({ model, oversample: 8, minRows: 2, exploreSlots: 0, warmupGenerations: 3, refitEvery: 2 })).not.toThrow();
  });
});

describe('evolveNumeric with a surrogate', () => {
  const base = { genomeSpec: SPEC, generations: 4, childrenPerGeneration: 3, seed: 7 } as const;

  it('without a surrogate the result carries no surrogate report', async () => {
    const result = await evolveNumeric({ ...base, evaluator: new XEvaluator(), workRoot: await tmpDir() });
    expect(result.surrogate).toBeUndefined();
  });

  it('keeps the evaluator budget, ranks an oversampled pool, and annotates what it picked', async () => {
    const plainEval = new XEvaluator();
    await evolveNumeric({ ...base, evaluator: plainEval, workRoot: await tmpDir() });

    const evaluator = new XEvaluator();
    const model = new OracleSurrogate();
    const events: NumericSurrogateEvent[] = [];
    const result = await evolveNumeric({
      ...base,
      evaluator,
      workRoot: await tmpDir(),
      surrogate: { model, oversample: 4, minRows: 4, onGeneration: (e) => events.push(e) },
    });

    // Generation 1 has only the baseline row → unscreened, identical to the plain run.
    expect(events[0]).toEqual({ generation: 1, screened: false, reason: '1 scored rows < minRows 4' });
    expect(evaluator.calls.slice(0, 4)).toEqual(plainEval.calls.slice(0, 4));

    const report = result.surrogate!;
    expect(report.generationsScreened).toBe(3);
    expect(report.fallbacks).toEqual([{ generation: 1, reason: '1 scored rows < minRows 4' }]);
    expect(report.candidatesRanked).toBe(model.predicted);
    // Every screened parent proposes 3 × 4 candidates and evaluates 3.
    expect(report.candidatesRanked).toBe(report.candidatesSelected * 4);

    // Budget: every evaluated variant is archived and scored, and never more per
    // parent than childrenPerGeneration.
    expect(evaluator.calls.length).toBe(result.records.length);
    for (const r of result.records) expect(r.children.length).toBeLessThanOrEqual(3);
    expect(new Set(evaluator.calls).size).toBe(evaluator.calls.length); // unique ids

    const screened = result.records.filter((r) => r.variant.generation >= 2);
    expect(screened.length).toBeGreaterThan(0);
    for (const r of screened) expect(r.variant.mutationSummary).toMatch(/\[surrogate: (explore slot, rank \d+\/12|rank \d+\/12, predicted [-\d.e]+)\]$/);
    // Per parent: exactly one explore slot, and the rest are the top predictions.
    const byParent = new Map<string, string[]>();
    for (const r of screened) byParent.set(r.variant.parentId!, [...(byParent.get(r.variant.parentId!) ?? []), r.variant.mutationSummary]);
    for (const summaries of byParent.values()) expect(summaries.filter((s) => s.includes('explore slot'))).toHaveLength(1);
  });

  it('with a truthful surrogate, screened children beat the unscreened ones they displaced', async () => {
    // exploreSlots 0 → all slots go to the top-predicted candidates; since the
    // oracle is exact and the pool contains the unscreened candidates, the best
    // evaluated child of each screened generation can only be at least as good.
    const plain = await evolveNumeric({ ...base, evaluator: new XEvaluator(), workRoot: await tmpDir() });
    const guided = await evolveNumeric({
      ...base,
      evaluator: new XEvaluator(),
      workRoot: await tmpDir(),
      surrogate: { model: new OracleSurrogate(), minRows: 2, exploreSlots: 0 },
    });
    expect(guided.winner!.score!.primary).toBeGreaterThanOrEqual(plain.winner!.score!.primary);
  });

  it('respects warm-up and refitEvery', async () => {
    const model = new OracleSurrogate();
    const events: NumericSurrogateEvent[] = [];
    await evolveNumeric({
      ...base,
      generations: 6,
      evaluator: new XEvaluator(),
      workRoot: await tmpDir(),
      surrogate: { model, minRows: 2, warmupGenerations: 2, refitEvery: 2, onGeneration: (e) => events.push(e) },
    });
    expect(events.slice(0, 2).map((e) => !e.screened && e.reason)).toEqual(['warm-up generation', 'warm-up generation']);
    expect(events.slice(2).every((e) => e.screened)).toBe(true);
    expect(model.fits).toHaveLength(2); // fitted at generations 3 and 5; 4 and 6 reuse
  });

  it.each([
    ['a declined fit', { decline: true }, /declined/],
    ['a throwing fit', { throwOnFit: true }, /fit exploded/],
    ['a throwing predict', { throwOnPredict: true }, /predict exploded/],
  ] as const)('fails open on %s: the run matches the unscreened one exactly', async (_name, behaviour, reason) => {
    const plainEval = new XEvaluator();
    const plain = await evolveNumeric({ ...base, evaluator: plainEval, workRoot: await tmpDir() });
    const evaluator = new XEvaluator();
    const result = await evolveNumeric({
      ...base,
      evaluator,
      workRoot: await tmpDir(),
      surrogate: { model: new OracleSurrogate(behaviour), minRows: 2 },
    });
    expect(evaluator.calls).toEqual(plainEval.calls);
    expect(result.records.map((r) => [r.variant.id, r.variant.genome, r.variant.mutationSummary])).toEqual(
      plain.records.map((r) => [r.variant.id, r.variant.genome, r.variant.mutationSummary]),
    );
    expect(result.surrogate!.generationsScreened).toBe(0);
    expect(result.surrogate!.fallbacks.length).toBeGreaterThan(0);
    expect(result.surrogate!.fallbacks.at(-1)!.reason).toMatch(reason);
  });

  it('leaves the crossover child alone and screens only the mutation slots', async () => {
    const result = await evolveNumeric({
      ...base,
      crossover: true,
      evaluator: new XEvaluator(),
      workRoot: await tmpDir(),
      surrogate: { model: new OracleSurrogate(), minRows: 2 },
    });
    const crossovers = result.records.filter((r) => r.variant.mutationSummary.startsWith('crossover'));
    for (const r of crossovers) expect(r.variant.mutationSummary).not.toContain('surrogate');
    for (const r of result.records) expect(r.children.length).toBeLessThanOrEqual(3);
  });

  it('rejects an invalid surrogate config before spending any evaluator call', async () => {
    const evaluator = new XEvaluator();
    await expect(
      evolveNumeric({ ...base, evaluator, workRoot: await tmpDir(), surrogate: { model: new OracleSurrogate(), oversample: 1 } }),
    ).rejects.toThrow(/oversample/);
    expect(evaluator.calls).toHaveLength(0);
  });
});
