// SPDX-License-Identifier: MIT
// ADR-228 §4.1 — $0 tests for the reflective-dataset builder's ADMISSION GATES: paired,
// verified-outcome, contamination scan, replay-eval convertibility (drop + count).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contaminationScan, approxFailureClass, summarizeRow, buildRecords } from './build-reflective-dataset.mjs';

const GOLD = 'diff --git a/src/parser.py b/src/parser.py\n--- a/src/parser.py\n+++ b/src/parser.py\n@@\n-    return self._parse(value)\n+    return self._parse(value, strict=strict_mode_enabled)\n';
const MANIFEST = [{ instance_id: 'r__p-1', repo: 'r/p', problem_statement: 'bug: strict mode ignored in parser' }];
const ROW_FAIL = { instance_id: 'r__p-1', steps: 12, executorActions: 12, thrash: 2, advisories: 0, vetoes: 0, submitted: false, resolvedInLoop: false, cost: 0.02 };

function mkArms({ teacherGold = true, advice = 'Read parser.py; the strict flag is dropped in _parse. Fix the call site.', teacherPatch = GOLD.replace('strict_mode_enabled', 'strict') } = {}) {
  return {
    'fadv-glm-solo': { kind: 'student', source: 's.json', gold: new Set(), preds: { 'r__p-1': '' }, report: { instances: [ROW_FAIL] } },
    'fadv-glm-fable': {
      kind: 'teacher', source: 't.json', goldSource: 'g.json',
      gold: new Set(teacherGold ? ['r__p-1'] : []),
      preds: { 'r__p-1': teacherPatch },
      report: { instances: [{ instance_id: 'r__p-1', advisoryLog: advice ? [{ step: 4, trigger: 'checkpoint', advice }] : [] }] },
    },
  };
}

test('happy path: paired + gold-verified teacher + clean scan → admitted, replay-convertible fields present', () => {
  const { records, counts } = buildRecords({ arms: mkArms(), manifest: MANIFEST, goldPatches: { 'r__p-1': GOLD } });
  assert.equal(counts.admitted, 1);
  const r = records[0];
  assert.equal(r.tenant_id, 'local-bench');
  assert.equal(r.task_signature, 'swebench-lite:r__p-1');
  for (const k of ['cheap_failed_trace', 'strong_success_trace', 'successful_patch', 'test_proof', 'retrieval_keys', 'replay_eligible']) assert.ok(r[k], `field ${k}`);
  assert.equal(r.replay_eligible, true);
  assert.equal(r.strong_success_trace.contamination, 'clean');
  assert.equal(r.failure_class, 3, 'empty patch → class 3');
  assert.match(r.cheap_failed_trace.summary, /patch=EMPTY/);
});

test('gate paired/verified-outcome: teacher not gold-resolved → dropped + counted', () => {
  const { records, counts } = buildRecords({ arms: mkArms({ teacherGold: false }), manifest: MANIFEST, goldPatches: { 'r__p-1': GOLD } });
  assert.equal(records.length, 0);
  assert.equal(counts.dropped['unpaired-no-verified-teacher'], 1);
});

test('gate contamination: advice quoting a gold added line → dropped + counted', () => {
  const dirty = 'Just write: return self._parse(value, strict=strict_mode_enabled) — done.';
  const { records, counts } = buildRecords({ arms: mkArms({ advice: dirty }), manifest: MANIFEST, goldPatches: { 'r__p-1': GOLD } });
  assert.equal(records.length, 0);
  assert.equal(counts.dropped['contaminated-advice'], 1);
});

test('gate unscanned: no gold patches → dropped unless --allow-unscanned', () => {
  const strict = buildRecords({ arms: mkArms(), manifest: MANIFEST, goldPatches: null });
  assert.equal(strict.counts.dropped['unscanned-no-gold-patch'], 1);
  const loose = buildRecords({ arms: mkArms(), manifest: MANIFEST, goldPatches: null, allowUnscanned: true });
  assert.equal(loose.counts.admitted, 1);
  assert.equal(loose.records[0].strong_success_trace.contamination, 'unscanned-allowed');
});

test('gate replay-convertibility: teacher without a successful patch → dropped + counted', () => {
  const arms = mkArms({ teacherPatch: null });
  const { counts } = buildRecords({ arms, manifest: MANIFEST, goldPatches: { 'r__p-1': GOLD } });
  assert.equal(counts.dropped['not-replay-convertible-no-successful-patch'], 1);
});

test('student that gold-resolved (or unknown gold) is not a training candidate', () => {
  const arms = mkArms();
  arms['fadv-glm-solo'].gold = new Set(['r__p-1']);
  assert.equal(buildRecords({ arms, manifest: MANIFEST, goldPatches: { 'r__p-1': GOLD } }).counts.dropped['student-not-a-failure'], 1);
  arms['fadv-glm-solo'].gold = null;
  assert.equal(buildRecords({ arms, manifest: MANIFEST, goldPatches: { 'r__p-1': GOLD } }).counts.dropped['student-gold-unknown'], 1);
});

test('oracle advice is the FALLBACK teacher (no gold-resolved arm), exempt from scan, gold patch as successful_patch', () => {
  const { records, counts } = buildRecords({
    arms: mkArms({ teacherGold: false }), manifest: MANIFEST, goldPatches: { 'r__p-1': GOLD },
    oracleAdvice: { 'r__p-1': 'The strict flag is dropped at the _parse call site; thread it through.' },
  });
  assert.equal(counts.admitted, 1);
  assert.equal(records[0].strong_success_trace.kind, 'oracle-advice');
  assert.equal(records[0].strong_success_trace.contamination, 'exempt-pre-authored');
  assert.equal(records[0].successful_patch, GOLD, 'gold patch by construction');
  assert.equal(records[0].test_proof, 'gold-patch-by-construction');
});

test('contaminationScan: short/derivable lines ignored, long verbatim added lines hit', () => {
  assert.equal(contaminationScan('use strict', GOLD).contaminated, false, 'short lines ignored');
  assert.equal(contaminationScan('x', null).scanned, false);
  const hit = contaminationScan('return self._parse(value, strict=strict_mode_enabled)', GOLD);
  assert.ok(hit.contaminated); assert.equal(hit.hits.length, 1);
});

test('approxFailureClass without transcripts: empty→3, wrong-file→1, gold-file→4', () => {
  assert.equal(approxFailureClass({ row: ROW_FAIL, patch: '' }), 3);
  const wrongFile = 'diff --git a/other.py b/other.py\n--- a/other.py\n+++ b/other.py\n@@\n+x\n';
  assert.equal(approxFailureClass({ row: ROW_FAIL, patch: wrongFile, goldPatchFiles: ['src/parser.py'] }), 1);
  const rightFile = wrongFile.replace(/other\.py/g, 'src/parser.py');
  assert.equal(approxFailureClass({ row: { ...ROW_FAIL, thrash: 0 }, patch: rightFile, goldPatchFiles: ['src/parser.py'] }), 4);
});

test('summarizeRow is a compact one-liner citing the load-bearing stats', () => {
  const s = summarizeRow('fadv-glm-solo', ROW_FAIL, '');
  assert.match(s, /12 steps/); assert.match(s, /thrash=2/); assert.match(s, /patch=EMPTY/);
});
