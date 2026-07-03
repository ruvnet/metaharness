// SPDX-License-Identifier: MIT
// ADR-228 §9.1 — ported from bench/swebench/gepa/metric.test.mjs (assertions unchanged): the
// pre-registered metric (§5.1), failure classes (§5.3), and ASI feedback generation (§5.2).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseActionRaw, analyzeTranscript, patchStats, goldFiles,
  computeInstanceScore, classifyFailure, makeFeedback, FAILURE_CLASSES,
} from '../src/gepa/metric.js';

const T = (tool: string, extra: Record<string, unknown> = {}, obs = 'ok') => ({ actionRaw: JSON.stringify({ tool, ...extra }), obs });
const PATCH = 'diff --git a/src/parser.py b/src/parser.py\n--- a/src/parser.py\n+++ b/src/parser.py\n@@ -1,3 +1,3 @@\n-old\n+new\n';

test('parseActionRaw: valid JSON, truncated JSON fallback, garbage', () => {
  assert.deepEqual(parseActionRaw('{"tool":"read","path":"a.py"}'), { tool: 'read', path: 'a.py' });
  const trunc = parseActionRaw('{"tool":"edit","path":"src/x.py","search":"very long unterminated');
  assert.equal(trunc.tool, 'edit'); assert.equal(trunc.path, 'src/x.py'); assert.ok(trunc._truncated);
  assert.equal(parseActionRaw('not json at all').tool, 'noop');
});

test('analyzeTranscript counts tools, edits, tests, thrash warnings', () => {
  const a = analyzeTranscript([
    T('grep', { pattern: 'x' }),
    T('read', { path: 'a.py' }),
    T('read', { path: 'a.py' }, 'a.py…\n⚠️ SYSTEM: You already ran this exact action and got this exact result. Stop repeating — change your strategy (read a different file / edit / run_tests) or submit.'),
    T('edit', { path: 'a.py' }, 'edit failed: SEARCH text did not match a.py (copy it character-for-character, indentation included)'),
    T('line_edit', { path: 'a.py' }, 'line_edit a.py: replaced lines 3-4 (+12 chars)'),
    T('edit', { path: 'tests/test_a.py' }, 'edit rejected: tests/test_a.py is a test file (never edit tests)'),
    T('run_tests', {}, 'run_tests: tests still failing:\nE assert'),
    T('run_tests', {}, 'run_tests: ALL TARGET TESTS PASS ✓ — call submit to finalize'),
    T('submit', {}, 'submitted.'),
  ]);
  assert.equal(a.steps, 9);
  assert.equal(a.counts.read, 2);
  assert.equal(a.editAttempts, 3);
  assert.equal(a.editsLanded, 1);
  assert.equal(a.editsFailed, 1);
  assert.equal(a.testFileEditAttempts, 1);
  assert.equal(a.runTestsCount, 2); assert.equal(a.runTestsFails, 1); assert.equal(a.runTestsPasses, 1);
  assert.equal(a.repeatedActionWarnings, 1);
  assert.deepEqual(a.filesEdited, ['a.py']);
  assert.ok(a.submitted);
});

test('patchStats: files, test files, changed lines, empty', () => {
  const ps = patchStats(PATCH + 'diff --git a/tests/test_p.py b/tests/test_p.py\n--- a/tests/test_p.py\n+++ b/tests/test_p.py\n@@\n+x\n');
  assert.deepEqual(ps.files, ['src/parser.py', 'tests/test_p.py']);
  assert.deepEqual(ps.nonTestFiles, ['src/parser.py']);
  assert.deepEqual(ps.testFiles, ['tests/test_p.py']);
  assert.equal(ps.changedLines, 3);
  assert.ok(patchStats('').empty);
  assert.deepEqual(goldFiles(PATCH), ['src/parser.py']);
});

test('metric §5.1: gold-resolved dominant, all bonuses itemized', () => {
  const analysis = analyzeTranscript([T('read', { path: 'src/parser.py' }), T('line_edit', { path: 'src/parser.py' }, 'line_edit src/parser.py: replaced lines 1-1 (+1 chars)'), T('run_tests', {}, 'run_tests: ALL TARGET TESTS PASS ✓'), T('submit', {}, 'submitted.')]);
  const { score, parts } = computeInstanceScore({
    goldResolved: true, resolvedInLoop: true, patch: PATCH, goldPatchFiles: ['src/parser.py'],
    analysis, cost: 0.05, thrash: 0,
  });
  assert.equal(parts.goldResolved, 10);
  assert.equal(parts.targetedTestsPass, 1);
  assert.equal(parts.minimalPatch, 0.5);
  assert.equal(parts.touchedExpectedFiles, 0.5);
  assert.equal(parts.emptyPatch, 0); assert.equal(parts.testFileEdits, 0); assert.equal(parts.noTestsRun, 0);
  assert.equal(parts.normalizedCost, -0.1);
  assert.equal(score, 11.9);
});

test('metric §5.1: all penalties fire on the degenerate run', () => {
  const analysis = analyzeTranscript([T('grep', { pattern: 'a' }), T('grep', { pattern: 'a' }, 'x\n⚠️ SYSTEM: You already ran this exact action and got this exact result. Stop repeating — change your strategy (read a different file / edit / run_tests) or submit.')]);
  const { score, parts } = computeInstanceScore({ goldResolved: false, patch: '', analysis, cost: 9, thrash: 1 });
  assert.equal(parts.emptyPatch, -1);
  assert.equal(parts.repeatedReads, -0.5);
  assert.equal(parts.noTestsRun, -0.5);
  assert.equal(parts.normalizedCost, -1, 'cost clamped to −1');
  assert.equal(score, -3);
});

test('metric: test-file edits penalized both via attempts and via patch content', () => {
  const viaAttempt = computeInstanceScore({ analysis: analyzeTranscript([T('edit', { path: 'tests/test_a.py' }, 'edit rejected: tests/test_a.py is a test file (never edit tests)'), T('run_tests', {}, 'x')]), patch: PATCH });
  assert.equal(viaAttempt.parts.testFileEdits, -1);
  const viaPatch = computeInstanceScore({ analysis: analyzeTranscript([T('run_tests', {}, 'x')]), patch: PATCH.replace(/src\/parser\.py/g, 'tests/test_parser.py') });
  assert.equal(viaPatch.parts.testFileEdits, -1);
});

test('classifyFailure precedence covers all 6 classes + resolved', () => {
  const gold = ['src/parser.py'];
  assert.equal(classifyFailure({ goldResolved: true, analysis: analyzeTranscript([]) }), 0);
  // 3: pure exploration, empty patch, no edit attempts
  assert.equal(classifyFailure({ analysis: analyzeTranscript([T('grep', {}), T('read', { path: 'x.py' })]), patch: '', goldPatchFiles: gold }), 3);
  // 2: edits attempted, none landed
  assert.equal(classifyFailure({ analysis: analyzeTranscript([T('edit', { path: 'src/parser.py' }, 'edit failed: SEARCH text did not match')]), patch: '', goldPatchFiles: gold }), 2);
  // 1: landed an edit somewhere else, never read/touched gold files
  const a1 = analyzeTranscript([T('read', { path: 'other.py' }), T('line_edit', { path: 'other.py' }, 'line_edit other.py: replaced lines 1-1 (+1 chars)')]);
  assert.equal(classifyFailure({ analysis: a1, patch: PATCH.replace(/src\/parser\.py/g, 'other.py'), goldPatchFiles: gold }), 1);
  // 5: hammering failing tests after touching the gold file
  const a5 = analyzeTranscript([T('read', { path: 'src/parser.py' }), T('line_edit', { path: 'src/parser.py' }, 'line_edit src/parser.py: replaced lines 1-1 (+1 chars)'),
    T('run_tests', {}, 'failing E'), T('run_tests', {}, 'failing E'), T('run_tests', {}, 'failing E')]);
  assert.equal(classifyFailure({ analysis: a5, patch: PATCH, goldPatchFiles: gold }), 5);
  // 4: right file, wrong fix
  const a4 = analyzeTranscript([T('read', { path: 'src/parser.py' }), T('line_edit', { path: 'src/parser.py' }, 'line_edit src/parser.py: replaced lines 1-1 (+1 chars)'), T('run_tests', {}, 'failing E'), T('submit', {}, 'submitted.')]);
  assert.equal(classifyFailure({ analysis: a4, patch: PATCH, goldPatchFiles: gold }), 4);
  // 6: edits landed, budget exhausted, no gold-file info
  const a6 = analyzeTranscript(Array.from({ length: 12 }, (_, i) => i === 5
    ? T('line_edit', { path: 'x.py' }, 'line_edit x.py: replaced lines 1-1 (+1 chars)') : T('read', { path: `f${i}.py` })));
  assert.equal(classifyFailure({ analysis: a6, patch: '', goldPatchFiles: null, maxSteps: 12 }), 6);
});

test('makeFeedback: ASI cites steps, files, gold gap, penalties, class hint, teacher pairing', () => {
  const analysis = analyzeTranscript([T('grep', { pattern: 'x' }), T('grep', { pattern: 'y' }), T('read', { path: 'utils.py' })]);
  const scored = computeInstanceScore({ analysis, patch: '', cost: 0.02, goldPatchFiles: ['src/parser.py'] });
  const fb = makeFeedback({
    instanceId: 'repo__proj-1', analysis, scored, failureClass: 3, goldPatchFiles: ['src/parser.py'],
    teacherSummary: 'Fable read parser.py, edited one conditional, ran test_parser_edge_case',
  });
  assert.match(fb, /repo__proj-1: score -?[\d.]+ \(gold FAIL\)/);
  assert.match(fb, /3 steps: 2 grep, 1 read/);
  assert.match(fb, /gold fix lives in \["src\/parser.py"\] — never read it/);
  assert.match(fb, /penalties: .*emptyPatch -1/);
  assert.match(fb, /failure class 3 \(exploration-loop/);
  assert.match(fb, /mutation target: retrieval_policy — stop grep loops/);
  assert.match(fb, /teacher \(paired success\/advice\): Fable read parser.py/);
});

test('makeFeedback: never-raise contract — evaluation error becomes a 0.0-score record', () => {
  const fb = makeFeedback({ instanceId: 'x__y-2', error: 'git fetch failed after 4 attempts' });
  assert.match(fb, /EVALUATION ERROR — git fetch failed/);
  assert.match(fb, /never-raise contract/);
});

test('FAILURE_CLASSES table is complete 0-6', () => {
  for (let i = 0; i <= 6; i++) assert.ok(FAILURE_CLASSES[i], `class ${i}`);
});
