// SPDX-License-Identifier: MIT
// ADR-228 §9.1 — $0 tests for the evaluator's pure assembly: metric wiring, teacher pairing,
// never-raise contract, metric-call accounting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleEvaluation, teacherSummaryFromRecord, indexReflective } from './evaluate-genome.mjs';

const MANIFEST = [
  { instance_id: 'a__x-1', repo: 'a/x', problem_statement: 'p1' },
  { instance_id: 'b__y-2', repo: 'b/y', problem_statement: 'p2' },
  { instance_id: 'c__z-3', repo: 'c/z', problem_statement: 'p3' },
];
const PATCH = 'diff --git a/src/m.py b/src/m.py\n--- a/src/m.py\n+++ b/src/m.py\n@@ -1 +1 @@\n-a\n+b\n';
const TR = (id, tools) => ({ instance_id: id, transcript: tools.map(([tool, extra, obs]) => ({ actionRaw: JSON.stringify({ tool, ...extra }), obs: obs ?? 'ok' })) });

test('assembleEvaluation: full happy path + gold + teacher pairing + metric calls', () => {
  const report = { instances: [
    { instance_id: 'a__x-1', resolvedInLoop: true, steps: 5, thrash: 0, cost: 0.05, submitted: true },
    { instance_id: 'b__y-2', resolvedInLoop: false, steps: 12, thrash: 3, cost: 0.10, submitted: false },
    { instance_id: 'c__z-3', resolvedInLoop: false, steps: 2, thrash: 0, cost: 0.01, error: 'git fetch failed' },
  ] };
  const transcripts = {
    'a__x-1': TR('a__x-1', [['read', { path: 'src/m.py' }], ['line_edit', { path: 'src/m.py' }, 'line_edit src/m.py: replaced lines 1-1 (+1 chars)'], ['run_tests', {}, 'run_tests: ALL TARGET TESTS PASS ✓'], ['submit', {}, 'submitted.']]),
    'b__y-2': TR('b__y-2', [['grep', { pattern: 'q' }], ['grep', { pattern: 'q' }, 'x\n⚠️ SYSTEM: You already ran this exact action and got this exact result. Stop repeating — change your strategy (read a different file / edit / run_tests) or submit.']]),
  };
  const reflective = { 'b__y-2': { instance_id: 'b__y-2', strong_success_trace: { arm: 'advbench-B-med', kind: 'acting-success' }, successful_patch: PATCH } };
  const ev = assembleEvaluation({
    manifest: MANIFEST, report, preds: { 'a__x-1': PATCH, 'b__y-2': '' },
    transcripts, resolvedIds: new Set(['a__x-1']), goldPatches: { 'a__x-1': PATCH, 'b__y-2': PATCH },
    reflective,
  });
  assert.equal(ev.metricCalls, 3, 'contract 4: N instances = N metric calls');
  assert.equal(ev.goldResolved, 1);
  assert.ok(ev.scores['a__x-1'] > 11, 'gold + bonuses');
  assert.ok(ev.scores['b__y-2'] < 0, 'penalties on the failure');
  assert.equal(ev.scores['c__z-3'], 0.0, 'never-raise: solver error → 0.0');
  assert.match(ev.feedbacks['c__z-3'], /EVALUATION ERROR — solver error: git fetch failed/);
  assert.match(ev.feedbacks['b__y-2'], /teacher \(paired success\/advice\): \[advbench-B-med\/acting-success\] resolved gold with a patch touching \["src\/m.py"\]/);
  assert.equal(ev.details['b__y-2'].failureClass, 3);
  assert.ok(Math.abs(ev.cost - 0.15) < 1e-9, 'errored row cost not accrued');
  assert.equal(ev.sumScore, Math.round((ev.scores['a__x-1'] + ev.scores['b__y-2']) * 1000) / 1000);
});

test('assembleEvaluation: missing report row → 0.0 + error feedback (budget-capped run)', () => {
  const ev = assembleEvaluation({ manifest: MANIFEST, report: { instances: [] }, resolvedIds: new Set() });
  assert.deepEqual(Object.values(ev.scores), [0, 0, 0]);
  assert.match(ev.feedbacks['a__x-1'], /no report row/);
});

test('assembleEvaluation: --no-gold mode (resolvedIds null) never credits gold', () => {
  const report = { instances: [{ instance_id: 'a__x-1', resolvedInLoop: true, steps: 3, thrash: 0, cost: 0.01 }] };
  const ev = assembleEvaluation({ manifest: [MANIFEST[0]], report, preds: { 'a__x-1': PATCH }, transcripts: {}, resolvedIds: null });
  assert.ok(ev.scores['a__x-1'] < 10, 'no gold credit');
  assert.equal(ev.goldResolved, 0);
});

test('teacherSummaryFromRecord: advisory vs acting vs null', () => {
  assert.equal(teacherSummaryFromRecord(null), null);
  assert.match(teacherSummaryFromRecord({ strong_success_trace: { arm: 'D', kind: 'advisory', advice_excerpt: 'read parser.py' } }), /^\[D\/advisory\] read parser.py/);
  assert.match(teacherSummaryFromRecord({ strong_success_trace: { arm: 'B', kind: 'acting-success' }, successful_patch: PATCH }), /\[B\/acting-success\] resolved gold with a patch touching \["src\/m.py"\]/);
});

test('indexReflective: first record per instance wins', () => {
  const idx = indexReflective({ records: [
    { instance_id: 'i1', strong_success_trace: { arm: 'first' } },
    { instance_id: 'i1', strong_success_trace: { arm: 'second' } },
    { instance_id: 'i2', strong_success_trace: { arm: 'only' } },
  ] });
  assert.equal(idx.i1.strong_success_trace.arm, 'first');
  assert.equal(Object.keys(idx).length, 2);
});
