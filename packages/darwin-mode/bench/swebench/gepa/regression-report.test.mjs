// SPDX-License-Identifier: MIT
// ADR-228 §5.4 — $0 tests for the mutation-lesson regression report (coordinator directive 1):
// failure-mode derivation, seed-frozen baseline diffing, lesson generation, log parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureModesForInstance, aggregateFailureModes, deriveLesson, buildRegressionReport, decisionsFromLog } from './regression-report.mjs';

test('failureModesForInstance: derives all 6 modes from parts + ASI text', () => {
  const fm = failureModesForInstance(
    { emptyPatch: -1, noTestsRun: -0.5, repeatedReads: -0.5, testFileEdits: -1 },
    'x: score -3.\n5 steps: 3 grep; 2 malformed turns; 4 repeated-action warnings (thrash).\nfailure class 1 (localization-failure). gold fix lives in ["a.py"] — never read it',
  );
  assert.deepEqual(fm, { empty_patch: true, wrong_file: true, test_not_run: true, thrash: true, bad_submit: true, protocol_error: true });
  const clean = failureModesForInstance({ goldResolved: 10 }, 'x: score 11.9 (gold RESOLVED). fine');
  assert.deepEqual(clean, { empty_patch: false, wrong_file: false, test_not_run: false, thrash: false, bad_submit: false, protocol_error: false });
});

test('aggregateFailureModes counts across instances, optionally filtered', () => {
  const details = { a: { parts: { emptyPatch: -1 } }, b: { parts: { emptyPatch: -1, noTestsRun: -0.5 } } };
  const feedbacks = { a: '', b: '' };
  assert.deepEqual(aggregateFailureModes(details, feedbacks).empty_patch, 2);
  assert.equal(aggregateFailureModes(details, feedbacks).test_not_run, 1);
  assert.equal(aggregateFailureModes(details, feedbacks, ['a']).empty_patch, 1);
});

test('deriveLesson: AVOID for rejected regressions naming the introduced failure mode', () => {
  const lesson = deriveLesson({
    target: 'retrieval_policy', decision: 'rejected', goldSeed: 3, goldCand: 1,
    regressed: ['i1', 'i2'], improved: [],
    seedModes: { empty_patch: 4, thrash: 1 }, candModes: { empty_patch: 7, thrash: 1 },
  });
  assert.match(lesson, /^AVOID: mutating retrieval_policy increased empty_patch 4→7/);
  assert.match(lesson, /gold 3→1/);
});

test('deriveLesson: KEEP for accepted gold improvement', () => {
  const lesson = deriveLesson({ target: 'test_policy', decision: 'accepted', goldSeed: 3, goldCand: 5, regressed: [], improved: ['i1', 'i2'], seedModes: {}, candModes: {} });
  assert.match(lesson, /raised gold 3→5.*KEEP direction/);
});

test('buildRegressionReport: seed frozen as baseline, per-candidate diff + mutation_diff + lesson', () => {
  const seedEval = {
    genome: 'seed-agentic-v1', goldResolved: 3, sumScore: 34.3, n: 3,
    scores: { i1: 11, i2: -1, i3: 5 }, details: { i1: { parts: { goldResolved: 10 } }, i2: { parts: { emptyPatch: -1 } }, i3: { parts: {} } }, feedbacks: { i1: '', i2: '', i3: '' },
  };
  const candEvals = [{
    genome: 'cand-1', goldResolved: 1, sumScore: 9.8,
    scores: { i1: 11, i2: -3, i3: -1 }, details: { i1: { parts: { goldResolved: 10 } }, i2: { parts: { emptyPatch: -1, noTestsRun: -0.5 } }, i3: { parts: { emptyPatch: -1 } } }, feedbacks: { i1: '', i2: '', i3: '' },
  }];
  const genomes = {
    'seed-agentic-v1': { meta: { id: 'seed-agentic-v1' }, components: { retrieval_policy: 'explore then edit then test' } },
    'cand-1': { meta: { id: 'cand-1', parent: 'seed-agentic-v1', mutated: 'retrieval_policy' }, components: { retrieval_policy: 'grep exhaustively first' } },
  };
  const rep = buildRegressionReport({ seedEval, candidateEvals: candEvals, genomes, decisions: { 'cand-1': 'rejected' } });
  assert.equal(rep.baseline.frozen, true);
  assert.equal(rep.baseline.gold, 3);
  const c = rep.candidates[0];
  assert.equal(c.target, 'retrieval_policy');
  assert.deepEqual(c.regressed_instances.sort(), ['i2', 'i3']);
  assert.deepEqual(c.improved_instances, []);
  assert.equal(c.mutation_diff.before, 'explore then edit then test');
  assert.equal(c.mutation_diff.after, 'grep exhaustively first');
  assert.match(c.lesson, /AVOID: mutating retrieval_policy/);
  assert.equal(rep.lessons.length, 1);
});

test('decisionsFromLog parses accept/reject lines', () => {
  const log = `[gepa] eval #2 cand-1: gold 1/12\n[gepa] rejected: {"id":"cand-1","target":"retrieval_policy"}\n[gepa] accepted: {"id":"cand-3","target":"test_policy"}\n`;
  assert.deepEqual(decisionsFromLog(log), { 'cand-1': 'rejected', 'cand-3': 'accepted' });
});
