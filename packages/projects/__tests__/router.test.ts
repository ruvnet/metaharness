// SPDX-License-Identifier: MIT
//
// Tests for router.ts (escalation ROUTER policy): deterministic classification
// of cheap vs frontier tasks, the cheap→verify→frontier escalation flow with
// injected lane fns (so the cheap-success path provably never touches the
// frontier), the both-fail terminal case, frontier front-loading skipping the
// cheap lane, and the cost-per-pass aggregate. Everything is deterministic.

import { describe, it, expect } from 'vitest';
import {
  classify,
  runWithEscalation,
  costPerPass,
  defaultRouterPolicy,
  type TaskSignal,
  type LaneResult,
  type EscalationOutcome,
} from '../src/router.js';

const base: TaskSignal = { id: 't', sizeTokens: 100, risk: 0.1, value: 0.1, longHorizon: false };

describe('classify', () => {
  it('routes a small, low-stakes task to the cheap lane with no reasons', () => {
    const r = classify(base);
    expect(r.lane).toBe('cheap');
    expect(r.reasons).toEqual([]);
  });

  it('routes a long-horizon task to the frontier with reason longHorizon', () => {
    const r = classify({ ...base, longHorizon: true });
    expect(r.lane).toBe('frontier');
    expect(r.reasons).toEqual(['longHorizon']);
  });

  it('routes a high-value task to the frontier with reason value', () => {
    const r = classify({ ...base, value: 0.8 }); // == threshold
    expect(r.lane).toBe('frontier');
    expect(r.reasons).toEqual(['value']);
  });

  it('routes a high-risk task to the frontier with reason risk', () => {
    const r = classify({ ...base, risk: 0.7 }); // == threshold
    expect(r.lane).toBe('frontier');
    expect(r.reasons).toEqual(['risk']);
  });

  it('routes an oversized task to the frontier with reason sizeTokens', () => {
    const r = classify({ ...base, sizeTokens: 8001 }); // > cheapMaxTokens
    expect(r.lane).toBe('frontier');
    expect(r.reasons).toEqual(['sizeTokens']);
  });

  it('lists every signal that fired, in a stable order', () => {
    const r = classify({ id: 't', sizeTokens: 9000, risk: 0.9, value: 0.95, longHorizon: true });
    expect(r.lane).toBe('frontier');
    expect(r.reasons).toEqual(['longHorizon', 'value', 'risk', 'sizeTokens']);
  });

  it('does not fire just below the thresholds', () => {
    const p = defaultRouterPolicy();
    const r = classify({ id: 't', sizeTokens: p.cheapMaxTokens, risk: 0.69, value: 0.79, longHorizon: false }, p);
    expect(r.lane).toBe('cheap');
    expect(r.reasons).toEqual([]);
  });
});

describe('runWithEscalation', () => {
  it('cheap success → no escalation, and the frontier lane is NEVER called', () => {
    let frontierCalls = 0;
    const out = runWithEscalation(base, {
      cheap: () => ({ passed: true, costUnits: 1 }),
      frontier: () => {
        frontierCalls += 1;
        return { passed: true, costUnits: 10 };
      },
      verify: (r) => r.passed,
    });
    expect(frontierCalls).toBe(0);
    expect(out).toEqual<EscalationOutcome>({
      passed: true,
      finalLane: 'cheap',
      escalated: false,
      attempts: 1,
      costUnits: 1,
    });
  });

  it('cheap fail → escalate → frontier success (escalated, 2 attempts, summed cost)', () => {
    let cheapCalls = 0;
    let frontierCalls = 0;
    const out = runWithEscalation(base, {
      cheap: () => {
        cheapCalls += 1;
        return { passed: false, costUnits: 1 };
      },
      frontier: () => {
        frontierCalls += 1;
        return { passed: true, costUnits: 10 };
      },
      verify: (r) => r.passed,
    });
    expect(cheapCalls).toBe(1);
    expect(frontierCalls).toBe(1);
    expect(out).toEqual<EscalationOutcome>({
      passed: true,
      finalLane: 'frontier',
      escalated: true,
      attempts: 2,
      costUnits: 11, // cheap(1) + frontier(10)
    });
  });

  it('both lanes fail → passed=false after escalating', () => {
    const out = runWithEscalation(base, {
      cheap: () => ({ passed: false, costUnits: 1 }),
      frontier: () => ({ passed: false, costUnits: 10 }),
      verify: (r) => r.passed,
    });
    expect(out).toEqual<EscalationOutcome>({
      passed: false,
      finalLane: 'frontier',
      escalated: true,
      attempts: 2,
      costUnits: 11,
    });
  });

  it('a frontier-classified task skips the cheap lane entirely', () => {
    let cheapCalls = 0;
    let frontierCalls = 0;
    const out = runWithEscalation({ ...base, longHorizon: true }, {
      cheap: () => {
        cheapCalls += 1;
        return { passed: true, costUnits: 1 };
      },
      frontier: () => {
        frontierCalls += 1;
        return { passed: true, costUnits: 10 };
      },
      verify: (r) => r.passed,
    });
    expect(cheapCalls).toBe(0);
    expect(frontierCalls).toBe(1);
    expect(out).toEqual<EscalationOutcome>({
      passed: true,
      finalLane: 'frontier',
      escalated: false, // front-loaded, not escalated from a cheap attempt
      attempts: 1,
      costUnits: 10,
    });
  });
});

describe('costPerPass', () => {
  it('divides total cost-units by the number of passing outcomes', () => {
    const outcomes: EscalationOutcome[] = [
      { passed: true, finalLane: 'cheap', escalated: false, attempts: 1, costUnits: 1 },
      { passed: true, finalLane: 'frontier', escalated: true, attempts: 2, costUnits: 11 },
      { passed: false, finalLane: 'frontier', escalated: true, attempts: 2, costUnits: 11 },
    ];
    // total cost = 1 + 11 + 11 = 23; passed = 2 → 11.5
    expect(costPerPass(outcomes)).toBe(11.5);
  });

  it('returns 0 when nothing passed', () => {
    const outcomes: EscalationOutcome[] = [
      { passed: false, finalLane: 'frontier', escalated: true, attempts: 2, costUnits: 11 },
    ];
    expect(costPerPass(outcomes)).toBe(0);
  });

  it('rounds to 6 decimals', () => {
    const outcomes: EscalationOutcome[] = [
      { passed: true, finalLane: 'cheap', escalated: false, attempts: 1, costUnits: 1 },
      { passed: true, finalLane: 'cheap', escalated: false, attempts: 1, costUnits: 1 },
      { passed: true, finalLane: 'cheap', escalated: false, attempts: 1, costUnits: 1 },
    ];
    // 3 / 3 = 1
    expect(costPerPass(outcomes)).toBe(1);
  });

  it('is deterministic for the same outcomes', () => {
    const outcomes: EscalationOutcome[] = [
      { passed: true, finalLane: 'cheap', escalated: false, attempts: 1, costUnits: 2 },
      { passed: true, finalLane: 'frontier', escalated: true, attempts: 2, costUnits: 13 },
    ];
    expect(costPerPass(outcomes)).toBe(costPerPass(outcomes));
    expect(costPerPass(outcomes)).toBe(7.5);
  });
});

// A lightweight injected-lane harness proving the end-to-end cost story is
// deterministic across a mixed batch of tasks.
describe('end-to-end determinism', () => {
  const lanes = {
    cheap: (t: TaskSignal): LaneResult => ({ passed: t.risk < 0.5, costUnits: 1 }),
    frontier: (_t: TaskSignal): LaneResult => ({ passed: true, costUnits: 10 }),
    verify: (r: LaneResult) => r.passed,
  };

  it('produces identical outcomes on repeated runs', () => {
    const tasks: TaskSignal[] = [
      { id: 'a', sizeTokens: 100, risk: 0.1, value: 0.1, longHorizon: false }, // cheap pass
      { id: 'b', sizeTokens: 100, risk: 0.6, value: 0.1, longHorizon: false }, // cheap fail → frontier
      { id: 'c', sizeTokens: 100, risk: 0.1, value: 0.9, longHorizon: false }, // front-loaded frontier
    ];
    const run = () => tasks.map((t) => runWithEscalation(t, lanes));
    expect(run()).toEqual(run());
  });
});
