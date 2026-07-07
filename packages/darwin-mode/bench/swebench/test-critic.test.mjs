#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Pure-function tests for the ADR-175 §63 / GH #47 symptom-binding signal in test-critic.mjs, plus the
// non-gating passthrough through repro-gate.mjs. NO network / NO Docker / NO LLM. Run: node test-critic.test.mjs
import assert from 'node:assert';
import { symptomBindingScore } from './test-critic.mjs';
import { reproGateSolve } from './repro-gate.mjs';

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };
const ta = async (name, fn) => { try { await fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

console.log('test-critic symptom-binding (ADR-175 §63 / #47) unit tests:');

t('binds when the failure raises an exception TYPE the issue names, and the repro references the issue identifier', () => {
  const issue = 'Calling `frobnicate()` on an empty list raises TypeError instead of returning None.';
  const repro = 'from mod import frobnicate\ndef test():\n    assert frobnicate([]) is None\n';
  const trace = 'Traceback (most recent call last):\n  ...\nTypeError: object of type NoneType has no len()';
  const s = symptomBindingScore(issue, repro, trace);
  assert.equal(s.assessable, true);
  assert.equal(s.boundExceptionType, true, 'TypeError named in issue AND raised in trace');
  assert.deepEqual(s.matchedExceptions, ['TypeError']);
  assert(s.matchedIdentifiers.includes('frobnicate'), 'repro references the issue identifier');
  assert.equal(s.score, 1, 'exception-bound (0.5) + all salient identifiers matched (0.5)');
});

t('does NOT bind the exception type when the trace raises a DIFFERENT exception than the issue names', () => {
  const issue = 'Calling `frobnicate()` raises TypeError on empty input.';
  const repro = 'from mod import frobnicate\ndef test():\n    assert frobnicate([]) == 0\n';
  const trace = 'AssertionError: expected 0';
  const s = symptomBindingScore(issue, repro, trace);
  assert.equal(s.boundExceptionType, false, 'issue names TypeError but trace only has AssertionError');
  assert.equal(s.score, 0.5, 'no exception bind (0) + identifier match (0.5)');
});

t('is NOT assessable when the issue names neither an exception nor a salient identifier', () => {
  const s = symptomBindingScore('The rendered output looks wrong to me.', 'def test():\n    assert render() == "x"\n', 'AssertionError');
  assert.equal(s.assessable, false);
  assert.equal(s.score, null, 'no fabricated confidence when there is nothing to bind to');
});

t('filters generic stopwords so they do not count as issue identifiers', () => {
  // `value` and `result` are backtick-quoted but are stopwords → not salient identifiers; no exception named.
  const s = symptomBindingScore('The `value` in the `result` is off.', 'def test(): assert value == result', 'AssertionError');
  assert.equal(s.issueIdentifierCount, 0, 'stopwords are dropped');
  assert.equal(s.assessable, false);
});

t('caps salient identifiers at 3 and scores the matched fraction', () => {
  const issue = 'The functions `alpha()`, `beta()`, `gamma()`, `delta()` all misbehave.';
  const repro = 'assert alpha() and beta()';  // 2 of the first 3 salient (alpha, beta, gamma) referenced
  const s = symptomBindingScore(issue, repro, 'AssertionError');
  assert.equal(s.boundExceptionType, false);
  assert.equal(s.score, 0.333, `matched 2 of 3 salient identifiers → 0.5×2/3 rounded to 3dp; got ${s.score}`);
});

await ta('reproGateSolve passes the writer symptomBinding through to its result (non-gating)', async () => {
  const sb = { assessable: true, score: 0.5, boundExceptionType: false };
  const r = await reproGateSolve({
    writeRepro: async () => ({ valid: true, repro: 'def test(): assert x', cost: 0.01, symptomBinding: sb }),
    solveRound: async ({ round }) => ({ patch: `p${round}`, cost: 0.01 }),
    runRepro: ({ patch }) => ({ ran: true, passed: patch === 'p1', logTail: '' }),
    maxRounds: 2,
  });
  assert.equal(r.reproPassed, true);
  assert.deepEqual(r.symptomBinding, sb, 'the gate result carries the writer\'s symptom-binding');
});

await ta('reproGateSolve tolerates a writer that computed no symptomBinding (undefined) — never throws', async () => {
  const r = await reproGateSolve({
    writeRepro: async () => ({ valid: false, repro: '', cost: 0 }),   // invalid repro → no symptomBinding
    solveRound: async () => ({ patch: 'p', cost: 0 }),
    runRepro: () => ({ ran: true, passed: false, logTail: '' }),
    maxRounds: 1,
  });
  assert.equal(r.reproValid, false);
  assert.equal(r.symptomBinding, undefined);
});

console.log(`\n${pass} passed`);
