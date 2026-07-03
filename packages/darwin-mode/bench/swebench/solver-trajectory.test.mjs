#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Pure-function tests for solver-trajectory.mjs (ADR-231 forward-contract). NO network / NO Docker / NO LLM.
// Run: node packages/darwin-mode/bench/swebench/solver-trajectory.test.mjs
import assert from 'node:assert';
import {
  redactSecrets, isGoldTestPath, extractToolUse, localizationSources,
  deriveSelector, assembleTrajectoryRecord, serializeTrajectory,
} from './solver-trajectory.mjs';

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

console.log('solver-trajectory.mjs unit tests:');

// ── redaction ──
t('redactSecrets scrubs OpenRouter/OpenAI keys, bearer tokens, and emails', () => {
  assert.ok(!redactSecrets('key sk-or-v1-abcdef0123456789abcdef').includes('abcdef0123456789'));
  assert.ok(redactSecrets('sk-or-v1-abcdef0123456789abcdef').includes('[REDACTED]'));
  assert.ok(!redactSecrets('Authorization: Bearer eyJ0eXAiOiJKV1Qi.payload').includes('eyJ0eXAiOiJKV1Qi'));
  assert.equal(redactSecrets('contact ruv@ruv.net now'), 'contact [REDACTED-EMAIL] now');
  assert.equal(redactSecrets('plain/path/mod.py'), 'plain/path/mod.py'); // clean strings untouched
});

// ── gold-test-path heuristic (must match sota-attest.isTestFile) ──
t('isGoldTestPath flags test conventions, not source', () => {
  for (const p of ['django/tests/foo/test_x.py', 'src/conftest.py', 'a/b/mymod_test.py', 'pkg/test/helpers.py', 'test_utils.py'])
    assert.equal(isGoldTestPath(p), true, p);
  for (const p of ['django/forms/boundfield.py', 'src/testing/util.py', 'requests/models.py', '/dev/null'])
    assert.equal(isGoldTestPath(p), false, p);
});

// ── tool / files-read extraction from the ReAct transcript ──
t('extractToolUse recovers tool names + read/edit/ls paths (paths only, no content)', () => {
  const transcript = [
    { actionRaw: '{"tool":"ls","dir":"src"}', obs: 'a\nb' },
    { actionRaw: '{"tool":"read","path":"src/mod.py","start":1,"end":40}', obs: '1\tcode' },
    { actionRaw: '{"tool":"grep","pattern":"def foo"}', obs: 'match' },
    { actionRaw: '{"tool":"edit","path":"./src/mod.py","search":"a","replace":"b"}', obs: 'edited' },
    { actionRaw: 'not json at all', obs: 'x' },
  ];
  const { tools_used, files_read } = extractToolUse(transcript);
  assert.deepEqual([...tools_used].sort(), ['edit', 'grep', 'ls', 'read']);
  assert.ok(files_read.includes('src/mod.py'), 'read/edit path captured, ./ normalized');
  assert.ok(files_read.includes('src/'), 'ls dir captured');
  assert.ok(!files_read.some((f) => f.includes('def foo')), 'grep pattern is NOT a file read');
});

t('extractToolUse handles the native tool_call shape', () => {
  const transcript = [{ actionRaw: '{"function":{"name":"read","arguments":"{\\"path\\":\\"pkg/x.py\\"}"}}', obs: '' }];
  const { tools_used, files_read } = extractToolUse(transcript);
  assert.ok(tools_used.includes('read'));
  assert.ok(files_read.includes('pkg/x.py'));
});

// ── localization sources ──
t('localizationSources pulls file paths from a localize/trace seed, deduped + normalized', () => {
  const semanticSeed = { files: [{ file: 'a/mod.py', score: 0.9 }, { file: './b/util.py' }] };
  const traceSeed = { files: [{ file: 'a/mod.py' }, { file: 'c/handler.py' }] };
  const src = localizationSources(semanticSeed, traceSeed);
  assert.deepEqual(src.sort(), ['a/mod.py', 'b/util.py', 'c/handler.py']);
});

t('localizationSources also accepts arrays of strings / {file}', () => {
  assert.deepEqual(localizationSources(['x.py', { file: 'y.py' }]).sort(), ['x.py', 'y.py']);
  assert.deepEqual(localizationSources(null, undefined), []);
});

// ── selector derivation (the winner-pick signal — must never be gold under conformance) ──
t('deriveSelector: conformant single/cascade rank on repro tests; oracle mode ranks on gold-oracle', () => {
  // default single, conformant
  assert.deepEqual(deriveSelector({ tier: 'T1' }, { noTestOracle: true }).ranked_on, ['conformant-repro-tests']);
  // default single, NON-conformant (oracle in-loop) → gold signal (sota-attest must fail this)
  assert.deepEqual(deriveSelector({ tier: 'T1' }, { noTestOracle: false }).ranked_on, ['gold-oracle']);
  // cascade T2 winner, conformant
  const casc = deriveSelector({ tier: 'T2' }, { noTestOracle: true });
  assert.equal(casc.method, 'cascade'); assert.equal(casc.candidates_n, 2); assert.deepEqual(casc.ranked_on, ['conformant-repro-tests']);
  // cascade judge tie-break → llm judge (non-gold)
  assert.deepEqual(deriveSelector({ tier: 'judge' }, { noTestOracle: true }).ranked_on, ['judge-llm']);
  // repro-gate
  assert.equal(deriveSelector({ tier: 'repro', reproRounds: 3 }, { noTestOracle: true }).method, 'repro-gate');
  // handoff chain
  const ho = deriveSelector({ tier: 'handoff:claude-p-fable', handoffHops: [{}, {}] }, { noTestOracle: true });
  assert.equal(ho.method, 'handoff-chain'); assert.equal(ho.candidates_n, 3); assert.deepEqual(ho.ranked_on, ['handoff-accept-heuristic']);
});

// ── full record assembly (the EVIDENCE object) ──
t('assembleTrajectoryRecord (conformant): gold_test_paths_accessed empty, selector non-gold', () => {
  const rec = assembleTrajectoryRecord({
    instance_id: 'django__django-12345',
    transcripts: [[{ actionRaw: '{"tool":"read","path":"django/db/models/query.py"}', obs: '' }]],
    localizeSeeds: [{ files: [{ file: 'django/db/models/query.py' }] }],
    row: { tier: 'T1' },
    noTestOracle: true,
  });
  assert.equal(rec.instance_id, 'django__django-12345');
  assert.deepEqual(rec.gold_test_paths_accessed, [], 'conformant → no gold access');
  assert.ok(rec.files_read.includes('django/db/models/query.py'));
  assert.deepEqual(rec.localization_sources, ['django/db/models/query.py']);
  assert.deepEqual(rec.selector.ranked_on, ['conformant-repro-tests']);
  assert.equal(rec.no_test_oracle, true);
});

t('assembleTrajectoryRecord (oracle mode): records the gold-oracle access marker honestly', () => {
  const rec = assembleTrajectoryRecord({ instance_id: 'x', row: { tier: 'T1' }, noTestOracle: false });
  assert.equal(rec.gold_test_paths_accessed.length, 1, 'oracle-in-loop → gold access recorded');
  assert.match(rec.gold_test_paths_accessed[0], /oracle/i);
  assert.deepEqual(rec.selector.ranked_on, ['gold-oracle']);
});

t('assembleTrajectoryRecord redacts secrets in captured paths', () => {
  const rec = assembleTrajectoryRecord({
    instance_id: 'x',
    localizeSeeds: [{ files: [{ file: 'cfg/sk-or-v1-deadbeef0123456789cafe.py' }] }],
    row: { tier: 'T1' }, noTestOracle: true,
  });
  assert.ok(rec.localization_sources[0].includes('[REDACTED]'), 'secret in path scrubbed');
});

t('serializeTrajectory round-trips to parseable JSONL', () => {
  const recs = [assembleTrajectoryRecord({ instance_id: 'a', row: {}, noTestOracle: true }),
    assembleTrajectoryRecord({ instance_id: 'b', row: {}, noTestOracle: true })];
  const jsonl = serializeTrajectory(recs);
  const parsed = jsonl.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((r) => r.instance_id), ['a', 'b']);
});

console.log(`\n${pass} passed`);
