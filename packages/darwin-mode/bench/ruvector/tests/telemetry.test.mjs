// SPDX-License-Identifier: MIT
// ADR-201 telemetry math — pure-function unit tests. Run: node --test tests/telemetry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRate, retrievalLift, compression, turnBudgetSurvival, costAdjustedLift,
  costPerCorrectHop, contextDegradation, wilson, summarizeArm, compareArms,
} from '../telemetry.mjs';

test('resolveRate', () => {
  assert.equal(resolveRate([]), 0);
  assert.equal(resolveRate([{ resolved: true }, { resolved: false }]), 0.5);
  assert.equal(resolveRate([{ resolved: true }, { resolved: true }]), 1);
});

test('retrievalLift Δ = with − base (and reports backfire as negative)', () => {
  assert.ok(Math.abs(retrievalLift(0.6, 0.4) - 0.2) < 1e-9); // 0.2 (float-tolerant)
  assert.ok(retrievalLift(0.3, 0.5) < 0); // backfire on hard code → negative, reported straight
});

test('compression Cr = 1 − tokens_test/tokens_control', () => {
  assert.ok(Math.abs(compression(6000, 12000) - 0.5) < 1e-9); // half the tokens → Cr=0.5
  assert.equal(compression(12000, 12000), 0);                 // no compression
  assert.ok(compression(15000, 12000) < 0);                   // test sent MORE → Cr<0 (falsifies H3)
  assert.equal(compression(5000, 0), 0);                      // guard div0
});

test('turnBudgetSurvival S_T counts resolved-without-escalation', () => {
  const recs = [
    { resolved: true, escalated: false },  // survived
    { resolved: true, escalated: true },   // resolved but needed Opus → not survival
    { resolved: false, escalated: true },
    { resolved: true, escalated: false },  // survived
  ];
  assert.equal(turnBudgetSurvival(recs), 0.5);
  assert.equal(turnBudgetSurvival([]), 0);
});

test('costAdjustedLift L_C = Δresolve/Δcost with zero-cost guard', () => {
  assert.ok(Math.abs(costAdjustedLift(0.2, 0.5) - 0.4) < 1e-9);
  assert.equal(costAdjustedLift(0, 0), 0);
  assert.equal(costAdjustedLift(0.2, 0), null); // lift at ~zero marginal cost
});

test('costPerCorrectHop', () => {
  assert.ok(Math.abs(costPerCorrectHop(0.1, 0.2, 3) - 0.1) < 1e-9);
  assert.equal(costPerCorrectHop(0.1, 0.2, 0), null);
});

test('contextDegradation finds the knee where resolve collapses', () => {
  // strong below 10k, collapses above
  const recs = [];
  for (let i = 0; i < 10; i++) recs.push({ resolved: true, contextTokens: 2000 });
  for (let i = 0; i < 10; i++) recs.push({ resolved: true, contextTokens: 7000 });
  for (let i = 0; i < 10; i++) recs.push({ resolved: i < 2, contextTokens: 14000 }); // 20% resolve
  const d = contextDegradation(recs, { bucketSize: 5000, kneeFrac: 0.7 });
  assert.equal(d.best, 1);
  assert.equal(d.kneeTokenLo, 10000); // bucket [10000,15000) is the knee
  assert.equal(d.curve.length, 3);
});

test('wilson CI sane bounds', () => {
  const ci = wilson(50, 100);
  assert.ok(ci.lo > 0.39 && ci.lo < 0.41);
  assert.ok(ci.hi > 0.59 && ci.hi < 0.61);
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 0 });
  const perfect = wilson(10, 10);
  assert.ok(perfect.hi <= 1 && perfect.lo < 1);
});

test('summarizeArm aggregates resolve/survival/tokens/cost', () => {
  const recs = [
    { id: 'a', resolved: true, escalated: false, contextTokens: 1000, cost: 0.001 },
    { id: 'b', resolved: false, escalated: true, contextTokens: 3000, cost: 0.005 },
  ];
  const s = summarizeArm(recs);
  assert.equal(s.n, 2);
  assert.equal(s.resolved, 1);
  assert.equal(s.resolve, 0.5);
  assert.equal(s.survival_S_T, 0.5);
  assert.equal(s.meanContextTokens, 2000);
  assert.ok(Math.abs(s.totalCost - 0.006) < 1e-9);
});

test('compareArms produces Δ, Cr, L_C between control and test', () => {
  const control = [ // dense: 40% resolve, 12k tokens, $0.005
    { resolved: true, escalated: false, contextTokens: 12000, cost: 0.005 },
    { resolved: false, escalated: false, contextTokens: 12000, cost: 0.005 },
    { resolved: false, escalated: false, contextTokens: 12000, cost: 0.005 },
    { resolved: false, escalated: false, contextTokens: 12000, cost: 0.005 },
    { resolved: true, escalated: false, contextTokens: 12000, cost: 0.005 },
  ];
  const test = [ // ruvector: 60% resolve, 6k tokens (Cr=0.5), $0.006
    { resolved: true, escalated: false, contextTokens: 6000, cost: 0.006 },
    { resolved: true, escalated: false, contextTokens: 6000, cost: 0.006 },
    { resolved: false, escalated: false, contextTokens: 6000, cost: 0.006 },
    { resolved: true, escalated: false, contextTokens: 6000, cost: 0.006 },
    { resolved: false, escalated: false, contextTokens: 6000, cost: 0.006 },
  ];
  const cmp = compareArms(control, test);
  assert.ok(Math.abs(cmp.retrievalLift_delta - 0.2) < 1e-9);   // 60%−40%
  assert.ok(Math.abs(cmp.compression_Cr - 0.5) < 1e-9);        // 6k vs 12k
  // L_C = Δresolve(0.2) / Δcost(0.001) = 200
  assert.ok(Math.abs(cmp.costAdjustedLift_L_C - 200) < 1e-6);
});
