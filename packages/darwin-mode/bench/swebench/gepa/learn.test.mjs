// SPDX-License-Identifier: MIT
// $0 tests for `metaharness learn` (learn.mjs): the STRICT promotion predicate (gold-regress→reject;
// empty-patch-worse→reject; both-improve→promote), the report shape, and the composite key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEmptyPatchDetail, resolvedIdSet, emptyPatchRate, totalThrash, summarizeEval,
  evaluatePromotion, compositeKey, buildPromotionReport,
} from './learn.mjs';

// Fixture: a details map from an array of [gold, failureClass, thrash, cost] tuples.
const mkDetails = (rows) => Object.fromEntries(rows.map(([gold, fc, thrash, cost], i) =>
  [`inst-${i}`, { gold, failureClass: fc, thrash, cost }]));
const mkEval = (rows, extra = {}) => {
  const details = mkDetails(rows);
  const gold = rows.filter((r) => r[0]).length;
  const cost = Math.round(rows.reduce((s, r) => s + r[3], 0) * 1e4) / 1e4;
  return { details, goldResolved: gold, n: rows.length, sumScore: gold * 10, cost, ...extra };
};

// The REAL cand-6 holdout (from runs/holdout-01-seed.json + holdout-02-cand6.json), keyed by id so
// gold-superset is checked positionally-consistent between seed and cand.
const SEED_HOLDOUT_ROWS = [ // [gold, failureClass]
  [false, 3], [false, 3], [false, 4], [false, 3], [true, 0], [false, 3],
  [true, 0], [false, 4], [false, 3], [false, 3], [false, 3], [false, 5],
];
const CAND_HOLDOUT_ROWS = [
  [false, 3], [false, 3], [false, 6], [false, 2], [true, 0], [false, 3],
  [true, 0], [false, 5], [true, 0], [false, 4], [false, 3], [false, 4],
];
const mkHoldout = (rows, perCost) => mkEval(rows.map(([g, fc]) => [g, fc, 0, perCost]));

test('isEmptyPatchDetail / emptyPatchRate: class-3 is empty-patch', () => {
  assert.equal(isEmptyPatchDetail({ failureClass: 3 }), true);
  assert.equal(isEmptyPatchDetail({ failureClass: 4 }), false);
  const seed = mkDetails(SEED_HOLDOUT_ROWS.map(([g, fc]) => [g, fc, 0, 0.05]));
  assert.equal(emptyPatchRate(seed), 0.583); // 7/12
  const cand = mkDetails(CAND_HOLDOUT_ROWS.map(([g, fc]) => [g, fc, 0, 0.05]));
  assert.equal(emptyPatchRate(cand), 0.333); // 4/12
});

test('resolvedIdSet + totalThrash', () => {
  const d = mkDetails([[true, 0, 1, 0.1], [false, 3, 2, 0.1], [true, 0, 0, 0.1]]);
  assert.deepEqual([...resolvedIdSet(d)].sort(), ['inst-0', 'inst-2']);
  assert.equal(totalThrash(d), 3);
});

test('summarizeEval: gold, empty-patch-rate, cost/resolved', () => {
  const s = summarizeEval(mkHoldout(SEED_HOLDOUT_ROWS, 0.05));
  assert.equal(s.gold, 2);
  assert.equal(s.emptyPatchRate, 0.583);
  assert.equal(s.n, 12);
  assert.equal(s.costPerResolved, Math.round((0.05 * 12 / 2) * 1e4) / 1e4); // 0.3
  const zero = summarizeEval(mkHoldout(SEED_HOLDOUT_ROWS.map(() => [false, 3]), 0.05));
  assert.equal(zero.costPerResolved, Infinity); // 0 resolved
});

test('STRICT rule — PROMOTE: gold superset + empty-patch improves + cost/resolved not worse (real cand-6)', () => {
  const seed = summarizeEval(mkHoldout(SEED_HOLDOUT_ROWS, 0.05));
  const cand = summarizeEval(mkHoldout(CAND_HOLDOUT_ROWS, 0.03)); // more resolved, cheaper
  const v = evaluatePromotion({ seed, cand });
  assert.equal(v.promote, true);
  assert.deepEqual(v.checks, { goldNoRegress: true, emptyPatchImproves: true, costPerResolvedNotWorse: true });
  assert.equal(v.regressions.length, 0);
  assert.deepEqual(v.gains, ['inst-8']); // the one newly-resolved instance
  assert.match(v.reason, /^PROMOTE/);
});

test('STRICT rule — REJECT when gold regresses (a seed-resolved instance is lost)', () => {
  const seed = summarizeEval(mkHoldout(SEED_HOLDOUT_ROWS, 0.05));
  // cand loses inst-6 (was gold in seed), even though empty-patch would improve
  const lose = CAND_HOLDOUT_ROWS.map((r, i) => (i === 6 ? [false, 3] : r));
  const cand = summarizeEval(mkHoldout(lose, 0.03));
  const v = evaluatePromotion({ seed, cand });
  assert.equal(v.promote, false);
  assert.equal(v.checks.goldNoRegress, false);
  assert.ok(v.regressions.includes('inst-6'));
  assert.match(v.reason, /gold regressed/);
});

test('STRICT rule — REJECT when empty-patch rate does not improve', () => {
  const seed = summarizeEval(mkHoldout(SEED_HOLDOUT_ROWS, 0.05));
  // same golds as seed (no regression) but MORE empty patches → reject
  const worseEmpty = SEED_HOLDOUT_ROWS.map(([g, fc]) => (fc === 4 || fc === 5 ? [g, 3] : [g, fc]));
  const cand = summarizeEval(mkHoldout(worseEmpty, 0.03));
  const v = evaluatePromotion({ seed, cand });
  assert.equal(v.promote, false);
  assert.equal(v.checks.emptyPatchImproves, false);
  assert.match(v.reason, /empty-patch rate did not improve/);
});

test('STRICT rule — floor-tie: seed already at empty-patch floor (0); candidate ties it and improves gold+cost → PROMOTE', () => {
  // seed: 0 empty-patch (floor), 1 gold resolved
  const seedRows = [[true, 0], [false, 1], [false, 2], [false, 4]];
  const seed = summarizeEval(mkHoldout(seedRows, 0.10));
  assert.equal(seed.emptyPatchRate, 0); // confirms seed is genuinely at the floor
  // cand: also 0 empty-patch (ties the floor, does not "strictly improve"), but resolves one more
  // instance for the same total cost → strictly better on both other axes.
  const candRows = [[true, 0], [true, 1], [false, 2], [false, 4]];
  const cand = summarizeEval(mkHoldout(candRows, 0.05));
  const v = evaluatePromotion({ seed, cand });
  assert.equal(cand.emptyPatchRate, 0);
  assert.equal(v.checks.emptyPatchImproves, true); // floor-tie now satisfies the clause
  assert.equal(v.checks.goldNoRegress, true);
  assert.equal(v.checks.costPerResolvedNotWorse, true);
  assert.equal(v.promote, true);
  assert.match(v.reason, /^PROMOTE/);
});

test('STRICT rule — floor-tie with a neutral, zero-lift candidate (identical gold+cost) → still REJECT (no_improvement_at_floor)', () => {
  // seed and cand are byte-identical: both at the empty-patch floor, same gold, same cost. A
  // tie-at-floor must NOT be sufficient on its own — mirrors flywheel/gate.ts's
  // `no_improvement_at_noop_floor` guard: a no-op mutation must not be able to ride a floor-tie
  // into promotion with zero real improvement.
  const rows = [[true, 0], [false, 1], [false, 2], [false, 4]];
  const seed = summarizeEval(mkHoldout(rows, 0.10));
  const cand = summarizeEval(mkHoldout(rows, 0.10));
  const v = evaluatePromotion({ seed, cand });
  assert.equal(seed.emptyPatchRate, 0);
  assert.equal(cand.emptyPatchRate, 0);
  assert.equal(v.checks.emptyPatchImproves, false); // floor-tie alone is NOT enough
  assert.equal(v.promote, false);
  assert.match(v.reason, /tied at the floor.*no improvement/);
});

test('STRICT rule — floor-tie does NOT bypass the gold-regression backstop', () => {
  const seedRows = [[true, 0], [true, 1], [false, 2], [false, 4]];
  const seed = summarizeEval(mkHoldout(seedRows, 0.10));
  // cand ties the empty-patch floor and is cheaper, but loses a seed-resolved instance → reject.
  const candRows = [[true, 0], [false, 1], [false, 2], [false, 4]];
  const cand = summarizeEval(mkHoldout(candRows, 0.05));
  const v = evaluatePromotion({ seed, cand });
  assert.equal(seed.emptyPatchRate, 0);
  assert.equal(v.checks.goldNoRegress, false); // regression backstop still fires at the floor
  assert.equal(v.promote, false);
  assert.match(v.reason, /gold regressed/);
});

test('STRICT rule — off-floor behavior unchanged: tie above the floor still REJECTs (regression guard)', () => {
  const seed = summarizeEval(mkHoldout(SEED_HOLDOUT_ROWS, 0.05)); // emptyPatchRate 0.583, not at floor
  const tie = summarizeEval(mkHoldout(SEED_HOLDOUT_ROWS, 0.03)); // identical empty-patch rate (tie, off-floor)
  const v = evaluatePromotion({ seed, cand: tie });
  assert.equal(v.checks.emptyPatchImproves, false); // off-floor ties still rejected, as before
});

test('STRICT rule — REJECT when cost/resolved worsens', () => {
  const seed = summarizeEval(mkHoldout(SEED_HOLDOUT_ROWS, 0.05));       // $/resolved = 0.3
  const cand = summarizeEval(mkHoldout(CAND_HOLDOUT_ROWS, 0.20));       // 3 resolved but pricier: 0.8
  const v = evaluatePromotion({ seed, cand });
  assert.equal(v.checks.goldNoRegress, true);
  assert.equal(v.checks.emptyPatchImproves, true);
  assert.equal(v.checks.costPerResolvedNotWorse, false);
  assert.equal(v.promote, false);
  assert.match(v.reason, /cost\/resolved worsened/);
});

test('compositeKey: host+model+vertical+language+task_class+genome_version', () => {
  const k = compositeKey({ host: 'ruvultra', model: 'z-ai/glm-5.2', vertical: 'code-repair', language: 'python', task_class: 'bug-fix', genome_version: 'cand-6' });
  assert.equal(k, 'ruvultra+z-ai/glm-5.2+code-repair+python+bug-fix+cand-6');
  // missing parts default to 'unknown', never throws
  assert.equal(compositeKey({ host: 'h', model: 'm' }), 'h+m+unknown+unknown+unknown+unknown');
});

test('buildPromotionReport: shape, key, holdout-only verdict, train recorded', () => {
  const seedH = summarizeEval(mkHoldout(SEED_HOLDOUT_ROWS, 0.05));
  const candH = summarizeEval(mkHoldout(CAND_HOLDOUT_ROWS, 0.03));
  const seedT = summarizeEval(mkHoldout(SEED_HOLDOUT_ROWS.map(() => [false, 3]), 0.03));
  const candT = summarizeEval(mkHoldout(CAND_HOLDOUT_ROWS, 0.03));
  const rep = buildPromotionReport({
    host: 'ruvultra', model: 'z-ai/glm-5.2', slice: 'advisor-medium-25.json',
    seedId: 'cand-6', candId: 'cand-9', genomeVersion: 'cand-9',
    train: { seed: seedT, cand: candT }, holdout: { seed: seedH, cand: candH },
    run: { best: 'cand-9', frontier: ['cand-9'], budget: { totalCost: 7.5 }, holdout: { goldDelta: 1 } },
  });
  // required fields present
  for (const f of ['ranAt', 'key', 'keyParts', 'slice', 'seed', 'candidate', 'train', 'holdout', 'regressions', 'gains', 'checks', 'verdict', 'reason', 'rule', 'run']) {
    assert.ok(f in rep, `missing field ${f}`);
  }
  assert.equal(rep.verdict, 'promote');
  assert.equal(rep.key, 'ruvultra+z-ai/glm-5.2+code-repair+python+bug-fix+cand-9');
  assert.equal(rep.seed, 'cand-6');
  assert.equal(rep.candidate, 'cand-9');
  assert.equal(rep.holdout.seed.gold, 2);
  assert.equal(rep.holdout.cand.gold, 3);
  assert.ok(rep.train.seed && rep.train.cand); // TRAIN vs HOLDOUT both recorded
  assert.equal(rep.run.holdoutGoldDelta, 1);
});

test('buildPromotionReport: no candidate improvement (best===seed) → cand defaults to seed, reject (no empty-patch gain)', () => {
  const seedH = summarizeEval(mkHoldout(SEED_HOLDOUT_ROWS, 0.05));
  const rep = buildPromotionReport({
    host: 'h', model: 'm', slice: 's', seedId: 'seed', candId: 'seed', genomeVersion: 'seed',
    train: { seed: summarizeEval(mkHoldout(SEED_HOLDOUT_ROWS, 0.05)), cand: null },
    holdout: { seed: seedH, cand: null }, // cand omitted ⇒ compared to itself
  });
  assert.equal(rep.verdict, 'reject'); // identical ⇒ empty-patch does not strictly improve
});
