// SPDX-License-Identifier: MIT
//
// Tests for trace.ts (ADR-158 Darwin Trace Format & Cost Ledger).

import { describe, expect, it } from 'vitest';
import { sumCost } from '../src/core.js';
import { CostLedger, Tracer, detectLeaks } from '../src/trace.js';

describe('CostLedger.reconcile', () => {
  it('(1) reconciles exactly, flags perturbation and model-call shortfall', () => {
    const t = new Tracer('g-rec');
    t.span('planner', 'plan', { costUnits: 2 });
    t.span('model', 'code', { model: 'cheap', costUnits: 5 });
    t.span('model', 'review', { model: 'frontier', costUnits: 10 });
    t.span('test', 'pytest', { costUnits: 1 });
    const spans = t.spans();
    const ledger = new CostLedger(spans);

    const exact = ledger.reconcile(sumCost(spans));
    expect(exact.ok).toBe(true);
    expect(exact.unaccounted).toBe(0);
    expect(exact.unaccountedModelCalls).toBe(0);

    // Perturb accounted cost → not ok, delta surfaces.
    const off = ledger.reconcile(sumCost(spans) + 3);
    expect(off.ok).toBe(false);
    expect(off.unaccounted).toBe(3);

    // Expected 3 model calls but only 2 model spans → 1 unaccounted call.
    const missing = ledger.reconcile(sumCost(spans), 3);
    expect(missing.ok).toBe(false);
    expect(missing.unaccountedModelCalls).toBe(1);
  });

  it('flags a model span with zero cost as an unaccounted call', () => {
    const t = new Tracer('g-zero');
    t.span('model', 'free?', { model: 'cheap', costUnits: 0 });
    const ledger = new CostLedger(t.spans());
    const r = ledger.reconcile(0);
    expect(r.unaccountedModelCalls).toBe(1);
    expect(r.ok).toBe(false);
  });
});

describe('detectLeaks', () => {
  it('(2) finds repeated retrieval, frontier-on-low-risk, and oversized-context leaks', () => {
    const t = new Tracer('g-leak');
    // Repeated identical retrieval: first is fine, two dups waste 6 total.
    t.span('retrieval', 'load-repo', { costUnits: 3, tokensIn: 100 });
    t.span('retrieval', 'load-repo', { costUnits: 3, tokensIn: 100 });
    t.span('retrieval', 'load-repo', { costUnits: 3, tokensIn: 100 });
    // Frontier on low-risk work.
    t.span('model', 'lint fix (low-risk)', { model: 'frontier', costUnits: 12 });
    // Oversized retrieval context.
    t.span('retrieval', 'whole-tree', { costUnits: 8, tokensIn: 20000 });

    const leaks = detectLeaks(t.spans());
    expect(leaks).toHaveLength(3);
    // Sorted by wastedCostUnits desc.
    expect(leaks[0].wastedCostUnits).toBeGreaterThanOrEqual(leaks[1].wastedCostUnits);

    const repeated = leaks.find((l) => l.reason === 'repeated retrieval');
    expect(repeated?.count).toBe(2);
    expect(repeated?.wastedCostUnits).toBe(6);

    const frontier = leaks.find((l) => l.reason === 'frontier on low-risk');
    expect(frontier?.wastedCostUnits).toBe(12);

    const oversized = leaks.find((l) => l.reason === 'oversized context');
    expect(oversized?.wastedCostUnits).toBe(8);
  });

  it('reports no leaks on a clean trace', () => {
    const t = new Tracer('g-clean');
    t.span('retrieval', 'a', { costUnits: 1, tokensIn: 100 });
    t.span('retrieval', 'b', { costUnits: 1, tokensIn: 100 });
    t.span('model', 'code', { model: 'cheap', costUnits: 4 });
    expect(detectLeaks(t.spans())).toHaveLength(0);
  });
});

describe('Tracer determinism', () => {
  it('(3) same seed yields identical span ids', () => {
    const mk = () => {
      const t = new Tracer('g-det', 7);
      t.span('planner', 'p');
      t.span('model', 'm', { model: 'cheap', costUnits: 1 });
      return t.spans().map((s) => s.id);
    };
    expect(mk()).toEqual(mk());
  });
});
