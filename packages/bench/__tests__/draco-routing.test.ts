// SPDX-License-Identifier: MIT
// DRACO routing policy math (ADR-040) — pure, deterministic over a synthetic matrix.

import { describe, it, expect } from 'vitest';
import {
  type RoutingMatrix,
  alwaysPolicy,
  oracleQuality,
  oracleCostOptimal,
  routerPolicy,
  routerEscalate,
  domainRouter,
  analyse,
} from '../src/draco/routing.js';

// Two questions, two models. haiku is cheap ($3/1M) and opus dear ($45/1M).
// q1: haiku BEATS opus (0.80 vs 0.70). q2: opus beats haiku (0.90 vs 0.60).
const M: RoutingMatrix = {
  models: ['anthropic/claude-haiku-4.5', 'anthropic/claude-opus-4'],
  questionIds: ['q1', 'q2'],
  cells: {
    q1: { 'anthropic/claude-haiku-4.5': { quality: 0.8, tokens: 1000 }, 'anthropic/claude-opus-4': { quality: 0.7, tokens: 1000 } },
    q2: { 'anthropic/claude-haiku-4.5': { quality: 0.6, tokens: 1000 }, 'anthropic/claude-opus-4': { quality: 0.9, tokens: 1000 } },
  },
};

describe('always policies', () => {
  it('always_haiku averages haiku quality and costs haiku rate', () => {
    const p = alwaysPolicy(M, 'anthropic/claude-haiku-4.5');
    expect(p.quality).toBeCloseTo((0.8 + 0.6) / 2); // 0.70
    expect(p.costUSD).toBeCloseTo(2 * (1000 / 1e6) * 3); // 2 questions × haiku
  });
  it('always_opus is pricier per the table', () => {
    const haiku = alwaysPolicy(M, 'anthropic/claude-haiku-4.5');
    const opus = alwaysPolicy(M, 'anthropic/claude-opus-4');
    expect(opus.costUSD).toBeGreaterThan(haiku.costUSD * 5);
  });
});

describe('oracle policies', () => {
  it('oracle_quality picks the per-question best (haiku@q1, opus@q2)', () => {
    const o = oracleQuality(M);
    expect(o.picks).toEqual(['anthropic/claude-haiku-4.5', 'anthropic/claude-opus-4']);
    expect(o.quality).toBeCloseTo((0.8 + 0.9) / 2); // 0.85 — the quality upper bound
  });

  it('oracle_cost_optimal(eps=0) equals oracle_quality picks (no slack)', () => {
    const o = oracleCostOptimal(M, 0);
    expect(o.picks).toEqual(['anthropic/claude-haiku-4.5', 'anthropic/claude-opus-4']);
  });

  it('oracle_cost_optimal with slack prefers the cheaper model when within ε', () => {
    // ε=0.15: at q1 both models (0.8 vs 0.7) are within 0.15 of best(0.8) → cheap haiku.
    // at q2 only opus (0.9) is within 0.15 of best(0.9); haiku(0.6) is not → opus.
    const o = oracleCostOptimal(M, 0.15);
    expect(o.picks).toEqual(['anthropic/claude-haiku-4.5', 'anthropic/claude-opus-4']);
    // bigger ε=0.35: q2 haiku(0.6) now within 0.35 of 0.9 → cheap haiku wins on cost.
    const o2 = oracleCostOptimal(M, 0.35);
    expect(o2.picks).toEqual(['anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-4.5']);
  });
});

describe('router_v2 — adaptive escalation on the pre-signal', () => {
  // haiku signal: q1 high (0.9 → keep haiku), q2 low (0.3 → escalate to opus).
  const MS: RoutingMatrix = {
    models: ['anthropic/claude-haiku-4.5', 'anthropic/claude-opus-4'],
    questionIds: ['q1', 'q2'],
    cells: {
      q1: { 'anthropic/claude-haiku-4.5': { quality: 0.8, tokens: 1000, signal: 0.9 }, 'anthropic/claude-opus-4': { quality: 0.7, tokens: 1000, signal: 0.8 } },
      q2: { 'anthropic/claude-haiku-4.5': { quality: 0.6, tokens: 1000, signal: 0.3 }, 'anthropic/claude-opus-4': { quality: 0.9, tokens: 1000, signal: 0.8 } },
    },
  };

  it('keeps cheap when signal >= threshold, escalates when below', () => {
    const r = routerEscalate(MS, { cheapModel: 'anthropic/claude-haiku-4.5', escalateTo: 'anthropic/claude-opus-4', threshold: 0.5 });
    expect(r.picks).toEqual(['anthropic/claude-haiku-4.5', 'anthropic/claude-opus-4']); // keep q1, escalate q2
    expect(r.quality).toBeCloseTo((0.8 + 0.9) / 2); // 0.85 — matches the oracle here
  });

  it('charges the cheap probe always + the escalation when it fires', () => {
    const r = routerEscalate(MS, { cheapModel: 'anthropic/claude-haiku-4.5', escalateTo: 'anthropic/claude-opus-4', threshold: 0.5 });
    // q1: haiku only ($3/1M*1000). q2: haiku probe + opus escalation ($3 + $45)/1M*1000.
    const haiku = (1000 / 1e6) * 3;
    const opus = (1000 / 1e6) * 45;
    expect(r.costUSD).toBeCloseTo(haiku + (haiku + opus), 6);
  });

  it('threshold 0 never escalates (= always cheap)', () => {
    const r = routerEscalate(MS, { cheapModel: 'anthropic/claude-haiku-4.5', escalateTo: 'anthropic/claude-opus-4', threshold: 0 });
    expect(r.picks).toEqual(['anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-4.5']);
  });
});

describe('domain_router — learned, leave-one-out, no embeddings', () => {
  // 4 questions, 2 domains. In sci, haiku wins; in fin, opus wins.
  const MD: RoutingMatrix = {
    models: ['anthropic/claude-haiku-4.5', 'anthropic/claude-opus-4'],
    questionIds: ['sci-001', 'sci-002', 'fin-001', 'fin-002'],
    cells: {
      'sci-001': { 'anthropic/claude-haiku-4.5': { quality: 0.9, tokens: 1000 }, 'anthropic/claude-opus-4': { quality: 0.6, tokens: 1000 } },
      'sci-002': { 'anthropic/claude-haiku-4.5': { quality: 0.85, tokens: 1000 }, 'anthropic/claude-opus-4': { quality: 0.65, tokens: 1000 } },
      'fin-001': { 'anthropic/claude-haiku-4.5': { quality: 0.5, tokens: 1000 }, 'anthropic/claude-opus-4': { quality: 0.9, tokens: 1000 } },
      'fin-002': { 'anthropic/claude-haiku-4.5': { quality: 0.55, tokens: 1000 }, 'anthropic/claude-opus-4': { quality: 0.95, tokens: 1000 } },
    },
  };

  it('routes each domain to its historically-best model (LOO) and matches the oracle here', () => {
    const r = domainRouter(MD);
    // sci → haiku (learned from the OTHER sci question), fin → opus.
    expect(r.picks).toEqual([
      'anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-4.5',
      'anthropic/claude-opus-4', 'anthropic/claude-opus-4',
    ]);
    // = oracle on this clean split: mean(0.9,0.85,0.9,0.95)
    expect(r.quality).toBeCloseTo((0.9 + 0.85 + 0.9 + 0.95) / 4);
  });
});

describe('router + analyse', () => {
  it('a naive always-cheapest router = always_haiku', () => {
    const r = routerPolicy(M, 'router_v1', () => 'anthropic/claude-haiku-4.5');
    expect(r.quality).toBeCloseTo(0.7);
  });

  it('analyse reports each policy as a fraction of the oracle quality/dollar', () => {
    const oracle = oracleCostOptimal(M, 0.35); // all-haiku here → cheapest high q/$
    const scored = analyse([alwaysPolicy(M, 'anthropic/claude-opus-4'), oracle], oracle);
    expect(scored[1].pctOfOracle).toBeCloseTo(1); // oracle vs itself = 100%
    expect(scored[0].pctOfOracle!).toBeLessThan(1); // always_opus is below oracle q/$
  });
});
