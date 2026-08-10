// SPDX-License-Identifier: MIT
//
// ADR-249 signal seams: additive, opt-in trace-quality + deterministic cost
// inputs to the frozen scorer. Thesis under test: (a) with both seams absent
// the ScoreCard is byte-identical to the pre-seam scorer (expected values
// hand-computed from scoreWeights()); (b) injected signals move exactly the
// intended weighted terms; (c) the promotion gate and penalty layer are
// untouched. Honest bound: seams can shift baseScore by at most the
// traceQuality (0.15) + costEfficiency (0.10) weights and can never flip a
// safety/regression gate clause.
import { describe, expect, it } from 'vitest';
import { scoreVariant, scoreWeights } from '../src/scorer.js';
import type { ScoreSignals } from '../src/scorer.js';
import type { RunTrace, ScoreCard } from '../src/types.js';

/** Build a RunTrace with sane defaults; override only what a test cares about. */
function trace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    variantId: 'v',
    taskId: 't',
    startedAt: '2026-06-17T00:00:00.000Z',
    finishedAt: '2026-06-17T00:00:00.000Z',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    blockedActions: [],
    ...overrides,
  };
}

const w = scoreWeights();

describe('ADR-249 (a) — both seams absent ⇒ byte-identical to pre-seam scorer', () => {
  // Representative fixtures. Expected values are computed BY HAND from the
  // ADR-072 weights: base = .35·task + .20·test + .15·traceQ + .10·cost +
  // .10·latency + .10·safety, penalties subtracted after.
  it('perfect clean run: base = final = 0.985 exactly', () => {
    // .35·1 + .20·1 + .15·0.9 + .10·1 + .10·1 + .10·1 = 0.985
    const card = scoreVariant('v', [trace()], null, 0.05);
    expect(card.baseScore).toBe(0.985);
    expect(card.finalScore).toBe(0.985);
    expect(card.traceQuality).toBe(0.9);
    expect(card.costEfficiency).toBe(1);
    expect(card.latencyEfficiency).toBe(1);
  });

  it('half pass rate: base = final = 0.71 exactly', () => {
    // .35·0.5 + .20·0.5 + .135 + .10 + .10 + .10 = 0.175+0.1+0.335 = 0.71
    const card = scoreVariant(
      'v',
      [trace({ exitCode: 0 }), trace({ exitCode: 1 })],
      null,
      0.05,
    );
    expect(card.baseScore).toBe(0.71);
    expect(card.finalScore).toBe(0.71);
  });

  it('oversized trace keeps the 0.5 heuristic: base = 0.925 exactly', () => {
    // .35 + .20 + .15·0.5 + .10 + .10 + .10 = 0.925
    const big = 'x'.repeat(4 * 1024 * 1024 + 1);
    const card = scoreVariant('v', [trace({ stdout: big })], null, 0.05);
    expect(card.traceQuality).toBe(0.5);
    expect(card.baseScore).toBe(0.925);
    expect(card.finalScore).toBe(0.925);
  });

  it('penalty fixture: secret+destructive ⇒ final = 0.985 − 0.55 = 0.435 exactly', () => {
    const card = scoreVariant(
      'v',
      [trace({ stderr: 'token leaked while running rm -rf' })],
      null,
      0.05,
    );
    expect(card.baseScore).toBe(0.985);
    expect(card.finalScore).toBe(0.435);
  });

  it('blocked-actions fixture: safety 0 ⇒ base = final = 0.885 exactly', () => {
    // .35 + .20 + .135 + .10 + .10 + .10·0 = 0.885 (no penalty patterns fire)
    const card = scoreVariant(
      'v',
      [trace({ blockedActions: ['rogue.ts'] })],
      null,
      0.05,
    );
    expect(card.safetyScore).toBe(0);
    expect(card.baseScore).toBe(0.885);
    expect(card.finalScore).toBe(0.885);
  });

  it('omitted arg, explicit undefined, and empty record all produce deep-equal cards', () => {
    const fixtures: RunTrace[][] = [
      [trace()],
      [trace({ exitCode: 0 }), trace({ exitCode: 1 })],
      [trace({ stderr: 'token leaked while running rm -rf' })],
      [trace({ timedOut: true })],
      [],
    ];
    for (const traces of fixtures) {
      const omitted = scoreVariant('v', traces, null, 0.05);
      const explicit = scoreVariant('v', traces, null, 0.05, 120_000, undefined);
      const empty = scoreVariant('v', traces, null, 0.05, 120_000, {});
      expect(explicit).toEqual(omitted);
      expect(empty).toEqual(omitted);
    }
  });
});

describe('ADR-249 (b) — injected trace-quality signal', () => {
  it('replaces the heuristic and moves baseScore by exactly w.traceQuality·Δ', () => {
    // signal 0.6 vs heuristic 0.9: base = 0.985 − 0.15·0.3 = 0.94
    const card = scoreVariant('v', [trace()], null, 0.05, 120_000, {
      traceQuality: 0.6,
    });
    expect(card.traceQuality).toBe(0.6);
    expect(card.baseScore).toBe(0.94);
    expect(card.finalScore).toBe(0.94);
  });

  it('signal 1.0 lifts a clean run to the exact 1.0 base ceiling', () => {
    const card = scoreVariant('v', [trace()], null, 0.05, 120_000, {
      traceQuality: 1,
    });
    expect(card.traceQuality).toBe(1);
    expect(card.baseScore).toBe(1);
  });

  it('signal wins even when the size heuristic would have said 0.5', () => {
    const big = 'x'.repeat(4 * 1024 * 1024 + 1);
    const card = scoreVariant('v', [trace({ stdout: big })], null, 0.05, 120_000, {
      traceQuality: 0.8,
    });
    expect(card.traceQuality).toBe(0.8);
    // .35 + .20 + .15·0.8 + .30 = 0.97
    expect(card.baseScore).toBe(0.97);
  });

  it('is clamped to [0,1] and round6’d', () => {
    expect(
      scoreVariant('v', [trace()], null, 0.05, 120_000, { traceQuality: 1.5 })
        .traceQuality,
    ).toBe(1);
    expect(
      scoreVariant('v', [trace()], null, 0.05, 120_000, { traceQuality: -0.2 })
        .traceQuality,
    ).toBe(0);
    expect(
      scoreVariant('v', [trace()], null, 0.05, 120_000, {
        traceQuality: 0.1234567,
      }).traceQuality,
    ).toBe(0.123457);
  });

  it('non-finite signal falls back to the heuristic (absent semantics)', () => {
    const card = scoreVariant('v', [trace()], null, 0.05, 120_000, {
      traceQuality: Number.NaN,
    });
    expect(card).toEqual(scoreVariant('v', [trace()], null, 0.05));
  });
});

describe('ADR-249 (b) — deterministic cost input', () => {
  it('is 1.0 at or under budget (absent-equivalent finalScore)', () => {
    const baseline = scoreVariant('v', [trace()], null, 0.05);
    for (const units of [0, 50, 100]) {
      const card = scoreVariant('v', [trace()], null, 0.05, 120_000, {
        cost: { units, budgetUnits: 100 },
      });
      expect(card.costEfficiency).toBe(1);
      expect(card.finalScore).toBe(baseline.finalScore);
    }
  });

  it('decays as budget/units over budget, round6’d, moving base by w.costEfficiency·Δ', () => {
    const card = scoreVariant('v', [trace()], null, 0.05, 120_000, {
      cost: { units: 200, budgetUnits: 100 },
    });
    expect(card.costEfficiency).toBe(0.5);
    // 0.985 − 0.10·0.5 = 0.935
    expect(card.baseScore).toBe(0.935);
    expect(card.finalScore).toBe(0.935);

    const third = scoreVariant('v', [trace()], null, 0.05, 120_000, {
      cost: { units: 300, budgetUnits: 100 },
    });
    expect(third.costEfficiency).toBe(0.333333); // round6(100/300)
  });

  it('is monotone non-increasing in cost units', () => {
    const effAt = (units: number): number =>
      scoreVariant('v', [trace()], null, 0.05, 120_000, {
        cost: { units, budgetUnits: 100 },
      }).costEfficiency;
    const points = [0, 100, 101, 150, 200, 400, 1_000_000].map(effAt);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]).toBeLessThanOrEqual(points[i - 1]);
    }
    expect(points[0]).toBe(1);
    expect(points[points.length - 1]).toBeGreaterThan(0);
  });

  it('malformed cost input (zero/negative budget, negative or non-finite units) keeps 1.0', () => {
    const baseline = scoreVariant('v', [trace()], null, 0.05);
    const bad: ScoreSignals[] = [
      { cost: { units: 50, budgetUnits: 0 } },
      { cost: { units: 50, budgetUnits: -1 } },
      { cost: { units: -5, budgetUnits: 100 } },
      { cost: { units: Number.NaN, budgetUnits: 100 } },
      { cost: { units: 50, budgetUnits: Number.POSITIVE_INFINITY } },
    ];
    for (const signals of bad) {
      expect(scoreVariant('v', [trace()], null, 0.05, 120_000, signals)).toEqual(
        baseline,
      );
    }
  });

  it('both seams together compose additively through the weights', () => {
    // .35 + .20 + .15·0.6 + .10·0.5 + .10 + .10 = 0.89
    const card = scoreVariant('v', [trace()], null, 0.05, 120_000, {
      traceQuality: 0.6,
      cost: { units: 200, budgetUnits: 100 },
    });
    expect(card.baseScore).toBe(0.89);
    expect(card.finalScore).toBe(0.89);
    expect(
      w.taskSuccess + w.testPassRate + w.traceQuality * 0.6 + w.costEfficiency * 0.5 + w.latencyEfficiency + w.safetyScore,
    ).toBeCloseTo(0.89, 10);
  });

  it('latencyEfficiency stays pinned at 1.0 regardless of seams (wall-clock is still jitter)', () => {
    const card = scoreVariant(
      'v',
      [trace({ durationMs: 500_000 })],
      null,
      0.05,
      120_000,
      { traceQuality: 0.2, cost: { units: 999, budgetUnits: 1 } },
    );
    expect(card.latencyEfficiency).toBe(1);
  });
});

describe('ADR-249 (c) — promotion gate and penalty layer untouched', () => {
  const parent: ScoreCard = scoreVariant('parent', [trace()], null, 0.05);

  it('perfect injected signals cannot rescue a safety-gated child', () => {
    const weakParent: ScoreCard = { ...parent, finalScore: 0, testPassRate: 0 };
    const child = scoreVariant(
      'child',
      [trace({ blockedActions: ['rogue'] })],
      weakParent,
      0.05,
      120_000,
      { traceQuality: 1, cost: { units: 0, budgetUnits: 100 } },
    );
    expect(child.safetyScore).toBe(0);
    expect(child.promoted).toBe(false);
    expect(child.reason).toContain('safetyScore');
  });

  it('perfect injected signals cannot rescue a test-pass regression', () => {
    const cheapParent: ScoreCard = { ...parent, finalScore: 0, testPassRate: 1 };
    const child = scoreVariant(
      'child',
      [trace({ exitCode: 0 }), trace({ exitCode: 1 })],
      cheapParent,
      0.05,
      120_000,
      { traceQuality: 1 },
    );
    expect(child.promoted).toBe(false);
    expect(child.reason).toContain('regression');
  });

  it('penalty coefficients still subtract from the seam-adjusted base exactly', () => {
    const card = scoreVariant(
      'v',
      [trace({ stderr: 'token leaked while running rm -rf' })],
      null,
      0.05,
      120_000,
      { traceQuality: 0.6, cost: { units: 200, budgetUnits: 100 } },
    );
    expect(card.secretExposure).toBe(1);
    expect(card.destructiveAction).toBe(1);
    // base 0.89 − 0.30 − 0.25 = 0.34
    expect(card.finalScore).toBe(0.34);
  });

  it('a clean child clearing all four clauses is still promoted, with or without seams', () => {
    const lowParent: ScoreCard = { ...parent, finalScore: 0.5, testPassRate: 1 };
    const plain = scoreVariant('child', [trace()], lowParent, 0.05);
    const seamed = scoreVariant('child', [trace()], lowParent, 0.05, 120_000, {
      traceQuality: 0.9,
      cost: { units: 10, budgetUnits: 100 },
    });
    expect(plain.promoted).toBe(true);
    expect(seamed.promoted).toBe(true);
  });

  it('a degraded cost signal can drop finalScore below the promotion bar (score clause only)', () => {
    // Parent at 0.94: plain child (0.985) clears 0.94 + 0.02; a child paying
    // 10× budget (costEfficiency 0.1 ⇒ final 0.895) fails ONLY the score clause.
    const lowParent: ScoreCard = { ...parent, finalScore: 0.94, testPassRate: 1 };
    const plain = scoreVariant('child', [trace()], lowParent, 0.02);
    const costly = scoreVariant('child', [trace()], lowParent, 0.02, 120_000, {
      cost: { units: 1000, budgetUnits: 100 },
    });
    expect(plain.promoted).toBe(true);
    expect(costly.finalScore).toBe(0.895);
    expect(costly.promoted).toBe(false);
    expect(costly.reason).toContain('finalScore');
    // Non-score clauses unaffected by the seam:
    expect(costly.reason).not.toContain('safetyScore');
    expect(costly.reason).not.toContain('regression');
  });

  it('reproducibility: identical seam inputs yield deep-equal scorecards', () => {
    const signals: ScoreSignals = {
      traceQuality: 0.7,
      cost: { units: 130, budgetUnits: 100 },
    };
    const a = scoreVariant('v', [trace()], null, 0.05, 120_000, signals);
    const b = scoreVariant('v', [trace()], null, 0.05, 120_000, {
      traceQuality: 0.7,
      cost: { units: 130, budgetUnits: 100 },
    });
    expect(a).toEqual(b);
  });
});
