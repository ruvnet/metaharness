import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkLocalTasks, splitForSeed, runOperation } from './rule-learning-local-tasks.mjs';
import { inferRuleCandidates } from '../../dream-machine/packages/compile/src/rule-learning.ts';
test('shifted holdout combinations do not overlap training', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const split = splitForSeed(seed);
    const train = new Set(split.training.map(v => JSON.stringify(v)));
    assert(split.heldout.every(v => !train.has(JSON.stringify(v))));
    assert(split.heldout.every(v => v.state.x > Math.max(...split.training.map(t => t.state.x))));
  }
});
test('host operations perform actual filesystem and SQL state changes', async () => {
  assert.deepEqual(await runOperation('file-append', { state: { x: 4 }, action: 3 }), { x: 7 });
  assert.deepEqual(await runOperation('sqlite-insert', { state: { x: 4 }, action: 3 }), { x: 7 });
  await assert.rejects(runOperation('file-append', { state: { x: -1 }, action: 0 }));
});
test('learner only sees training; deterministic results fail interaction gate honestly', async () => {
  let calls = 0;
  const proposal = observations => {
    calls++;
    assert.equal(observations.length, 3);
    assert(observations.every(t => t.state.x < 100 && t.action >= 1 && t.action <= 3));
    return inferRuleCandidates(observations);
  };
  const first = await benchmarkLocalTasks(proposal);
  const second = await benchmarkLocalTasks(proposal);
  assert.equal(calls, 30);
  assert.deepEqual(first, second);
  assert.equal(first.acceptance, false);
  assert.equal(first.interactionReduction, 0);
  assert(first.families.filter(f => f.family !== 'deflate-length').every(f => f.handAuthoredDomainSuccesses === f.samples && f.gainOverDomainBaselinePoints === 0));
  assert(first.rows.every(r => r.replayMismatches === 0 && r.candidateInteractions === r.baselineInteractions));
});
