// SPDX-License-Identifier: MIT
//
// Tests for the evolve() pure helpers. The 'faster' tie-break (ADR-072 scorer
// is ceiling-bound, so finalScore ties are the norm) must, among the variants
// sharing the top finalScore, pick the most efficient one by mean trace ms —
// and must never let a higher-scoring-but-slower variant lose, nor a
// lower-scoring-but-faster one win.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateVariant, pickEfficientWinner, mapLimit, substantiveTraceRatio } from '../src/evolve.js';
import type {
  ArchiveRecord,
  EvolutionConfig,
  HarnessVariant,
  RepoProfile,
  RunTrace,
  ScoreCard,
} from '../src/types.js';

function card(finalScore: number): ScoreCard {
  return {
    variantId: 'x', taskSuccess: 1, testPassRate: 1, traceQuality: 0.9,
    costEfficiency: 1, latencyEfficiency: 1, safetyScore: 1,
    secretExposure: 0, destructiveAction: 0, hallucinatedFile: 0, toolLoop: 0, costOverrun: 0,
    baseScore: finalScore, finalScore, promoted: false, reason: 'test',
  };
}
function rec(id: string, finalScore: number | null): ArchiveRecord {
  return {
    variant: {
      id, parentId: null, generation: 0, dir: `/tmp/${id}`,
      mutationSurface: 'planner', mutationSummary: 's', createdAt: '2026-01-01T00:00:00Z',
    },
    score: finalScore === null ? null : { ...card(finalScore), variantId: id },
    children: [],
  };
}
function traces(id: string, ms: number): RunTrace[] {
  return [{
    variantId: id, taskId: 't', startedAt: '', finishedAt: '', exitCode: 0,
    stdout: '', stderr: '', durationMs: ms, timedOut: false, blockedActions: [],
  }];
}

describe('pickEfficientWinner', () => {
  it('returns null when no record is scored', () => {
    expect(pickEfficientWinner([rec('a', null), rec('b', null)], new Map())).toBeNull();
  });

  it('among equal top finalScore, picks the lowest mean trace ms', () => {
    const recs = [rec('slow', 0.985), rec('fast', 0.985), rec('mid', 0.985)];
    const t = new Map([
      ['slow', traces('slow', 900)],
      ['fast', traces('fast', 100)],
      ['mid', traces('mid', 500)],
    ]);
    expect(pickEfficientWinner(recs, t)!.variant.id).toBe('fast');
  });

  it('never sacrifices finalScore for speed (a faster lower-score variant cannot win)', () => {
    const recs = [rec('best', 0.985), rec('speedy', 0.5)];
    const t = new Map([
      ['best', traces('best', 800)],
      ['speedy', traces('speedy', 1)],
    ]);
    expect(pickEfficientWinner(recs, t)!.variant.id).toBe('best');
  });

  it('treats a variant with no traces as least efficient (Infinity)', () => {
    const recs = [rec('untimed', 0.985), rec('timed', 0.985)];
    const t = new Map([['timed', traces('timed', 700)]]);
    expect(pickEfficientWinner(recs, t)!.variant.id).toBe('timed');
  });
});

describe('mapLimit', () => {
  it('preserves order and bounds concurrency', async () => {
    let inFlight = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

// ADR-249 cost seam, wired here: `evaluateVariant` now feeds the deterministic
// `variantBytes` parsimony signal (same one 'pareto' selection already reads)
// into `scoreVariant`'s opt-in `signals.cost` when `EvolutionConfig.costBudgetBytes`
// is set. Thesis under test: (a) omitted ⇒ costEfficiency stays the pre-seam
// 1.0 regardless of on-disk size (byte-identical contract, ADR-249 honoured one
// level up); (b) set + under budget ⇒ still 1.0; (c) set + over budget ⇒ decays
// to exactly round6(budgetUnits/units); (d) that decay alone can flip a
// promotion decision on a crafted near-tie fixture, with no other clause moved.
describe('ADR-249 cost seam wired into evaluateVariant', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function variantWithBytes(byteSize: number): Promise<HarnessVariant> {
    const dir = await mkdtemp(join(tmpdir(), 'darwin-costseam-'));
    dirs.push(dir);
    // One file of an exact, known byte size (ASCII 'x' — 1 byte/char, no BOM).
    await writeFile(join(dir, 'surface.txt'), 'x'.repeat(byteSize), 'utf8');
    return {
      id: 'v', parentId: null, generation: 1, dir,
      mutationSurface: 'planner', mutationSummary: 'test fixture', createdAt: '2026-08-17T00:00:00Z',
    };
  }

  const profile: RepoProfile = {
    root: '/tmp/repo', packageManager: 'npm', testCommand: 'npm test',
    sourceFiles: [], riskFiles: [], summary: 'fixture',
  };

  // mockTasks: [] ⇒ no traces ⇒ taskSuccess/testPassRate = 0, safetyScore = 1
  // (vacuous), traceQuality = 0.9 default ⇒ baseScore = finalScore =
  // 0.335 + 0.10·costEfficiency (no penalty layer fires on zero traces).
  function baseConfig(overrides: Partial<EvolutionConfig> = {}): EvolutionConfig {
    return {
      repoRoot: '/tmp/repo', workRoot: '/tmp/work', generations: 1, childrenPerGeneration: 1,
      tasks: [], promotionDelta: 0.02, sandboxMode: 'mock', mockTasks: [], ...overrides,
    };
  }

  it('costBudgetBytes omitted ⇒ costEfficiency stays 1.0 regardless of on-disk size', async () => {
    const variant = await variantWithBytes(5000); // large — would decay hard if wired
    const { score } = await evaluateVariant(variant, profile, baseConfig(), null);
    expect(score.costEfficiency).toBe(1);
    expect(score.finalScore).toBeCloseTo(0.435, 6); // 0.335 + 0.10·1.0
  });

  it('costBudgetBytes set, variant AT/UNDER budget ⇒ costEfficiency stays 1.0', async () => {
    const variant = await variantWithBytes(50);
    const { score } = await evaluateVariant(variant, profile, baseConfig({ costBudgetBytes: 100 }), null);
    expect(score.costEfficiency).toBe(1);
  });

  it('costBudgetBytes set, variant OVER budget ⇒ costEfficiency decays to round6(budget/units)', async () => {
    const variant = await variantWithBytes(200);
    const { score } = await evaluateVariant(variant, profile, baseConfig({ costBudgetBytes: 100 }), null);
    expect(score.costEfficiency).toBe(0.5); // round6(100 / 200)
    expect(score.finalScore).toBeCloseTo(0.385, 6); // 0.335 + 0.10·0.5
  });

  it('the cost-seam decay alone can flip a promotion decision (no other clause moves)', async () => {
    const parentScore: ScoreCard = {
      variantId: 'parent', taskSuccess: 0, testPassRate: 0, traceQuality: 0.9,
      costEfficiency: 1, latencyEfficiency: 1, safetyScore: 1,
      secretExposure: 0, destructiveAction: 0, hallucinatedFile: 0, toolLoop: 0, costOverrun: 0,
      baseScore: 0.4, finalScore: 0.4, promoted: false, reason: 'fixture parent',
    };
    // promotionDelta 0.02 ⇒ child must exceed 0.42 to promote.
    const underBudget = await variantWithBytes(50);
    const promotedResult = await evaluateVariant(
      underBudget, profile, baseConfig({ costBudgetBytes: 100 }), parentScore,
    );
    expect(promotedResult.score.finalScore).toBeCloseTo(0.435, 6);
    expect(promotedResult.score.promoted).toBe(true);

    const overBudget = await variantWithBytes(200); // same budget, 2x over ⇒ costEfficiency 0.5
    const rejectedResult = await evaluateVariant(
      overBudget, profile, baseConfig({ costBudgetBytes: 100 }), parentScore,
    );
    expect(rejectedResult.score.finalScore).toBeCloseTo(0.385, 6);
    expect(rejectedResult.score.promoted).toBe(false);
    expect(rejectedResult.score.reason).toContain('finalScore');
  });
});

describe('substantiveTraceRatio (pure)', () => {
  function traceWith(stdout: string, stderr: string): RunTrace {
    return {
      variantId: 'v', taskId: 't', startedAt: '', finishedAt: '', exitCode: 0,
      stdout, stderr, durationMs: 1, timedOut: false, blockedActions: [],
    };
  }

  it('empty array ⇒ 0', () => {
    expect(substantiveTraceRatio([])).toBe(0);
  });

  it('all traces non-empty ⇒ 1', () => {
    expect(substantiveTraceRatio([traceWith('ok', ''), traceWith('', 'err')])).toBe(1);
  });

  it('all traces empty ⇒ 0', () => {
    expect(substantiveTraceRatio([traceWith('', ''), traceWith('', '')])).toBe(0);
  });

  it('mixed ⇒ exact fraction, no rounding applied here (scorer.ts rounds)', () => {
    expect(substantiveTraceRatio([traceWith('a', ''), traceWith('', ''), traceWith('', 'b')])).toBeCloseTo(2 / 3, 12);
  });
});

// ADR-249 traceQuality seam, wired here (sibling of the cost seam above):
// `evaluateVariant` now feeds `substantiveTraceRatio(traces)` into
// `scoreVariant`'s opt-in `signals.traceQuality` when
// `EvolutionConfig.traceQualityFromOutput` is true. Thesis under test: (a)
// omitted ⇒ traceQuality stays the pre-seam byte-cap heuristic (0.9 — real
// mock traces are always far under the 4MB cap) regardless of trace content;
// (b) set ⇒ traceQuality reflects the real substantive-output ratio, which
// can differ from 0.9 and therefore move finalScore.
describe('ADR-249 traceQuality seam wired into evaluateVariant', () => {
  const profile: RepoProfile = {
    root: '/tmp/repo', packageManager: 'npm', testCommand: 'npm test',
    sourceFiles: [], riskFiles: [], summary: 'fixture',
  };
  const variant: HarnessVariant = {
    id: 'v', parentId: null, generation: 1, dir: '/tmp/darwin-tq-fixture',
    mutationSurface: 'planner', mutationSummary: 'test fixture', createdAt: '2026-09-22T00:00:00Z',
  };

  function baseConfig(overrides: Partial<EvolutionConfig> = {}): EvolutionConfig {
    return {
      repoRoot: '/tmp/repo', workRoot: '/tmp/work', generations: 1, childrenPerGeneration: 1,
      tasks: [], promotionDelta: 0.02, sandboxMode: 'mock', ...overrides,
    };
  }

  it('traceQualityFromOutput omitted ⇒ traceQuality stays the pre-seam 0.9 heuristic', async () => {
    // Default DEFAULT_MOCK_TASKS traces (mockTasks omitted) always produce
    // non-empty stdout, so a wired seam would report 1.0 here — proving this
    // 0.9 is really the untouched pre-seam fallback, not a coincidence.
    const { score } = await evaluateVariant(variant, profile, baseConfig(), null);
    expect(score.traceQuality).toBe(0.9);
  });

  it('traceQualityFromOutput true ⇒ traceQuality reflects the real substantive-output ratio', async () => {
    const { score, traces: t } = await evaluateVariant(
      variant, profile, baseConfig({ traceQualityFromOutput: true }), null,
    );
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((tr) => tr.stdout.length + tr.stderr.length > 0)).toBe(true);
    // All DEFAULT_MOCK_TASKS traces are substantive ⇒ ratio 1.0, distinctly
    // different from the 0.9 pre-seam heuristic in the test above.
    expect(score.traceQuality).toBe(1);
    expect(score.traceQuality).not.toBe(0.9);
  });

  it('traceQualityFromOutput true, all-empty traces ⇒ traceQuality clamps to 0, distinct from safetyScore/toolLoop', async () => {
    const { score } = await evaluateVariant(
      variant, profile, baseConfig({ traceQualityFromOutput: true, sandboxMode: 'mock', mockTasks: [] }), null,
    );
    // mockTasks: [] ⇒ zero traces ⇒ substantiveTraceRatio([]) === 0.
    expect(score.traceQuality).toBe(0);
    // Orthogonality: no blockedActions were involved, so safety/toolLoop are untouched.
    expect(score.safetyScore).toBe(1);
    expect(score.toolLoop).toBe(0);
  });
});
