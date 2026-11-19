import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { evaluateCase } from './replay.mjs';
import { simulateResponse } from './simulation.mjs';

const id = text => createHash('sha256').update(text).digest('hex');
function replay(times, mode = 'simulate') {
  return evaluateCase({ version: 1, tenant: 'tenant', caseId: 'case', sourceSha256: id('fixture'),
    events: times.map((at, index) => ({ id: id('event' + index), session: id('session'),
      kind: 'decoy_hit', source: 'canary', at })) }, mode);
}

test('release at exact TTL precedes reacquisition by the same session', () => {
  const report = simulateResponse(replay([5, 300005]));
  assert.deepEqual(report.records.map(r => [r.type, r.at]), [
    ['intent', 5], ['applied', 5], ['expired', 300005],
    ['intent', 300005], ['applied', 300005], ['expired', 600005]
  ]);
  assert.equal(report.finalActive, 0);
  assert.equal(report.restored, true);
});

test('replayed intent and rollback change virtual state once', () => {
  const result = replay([0]);
  result.decisions.push({ ...result.decisions[0] });
  const rollback = { idempotencyKey: result.decisions[0].idempotencyKey, at: 4 };
  const report = simulateResponse(result, { rollbacks: [rollback, rollback] });
  assert.deepEqual(report.counts, { intents: 1, applied: 1, expired: 0, rolledBack: 1, duplicates: 2 });
  assert.equal(report.records[2].at, 4);
  assert.equal(report.restored, true);
});

test('conflicting idempotency, unknown rollback and overlapping sessions are rejected', () => {
  const result = replay([3]);
  const decision = result.decisions[0];
  assert.throws(() => simulateResponse(result, { rollbacks: [{ idempotencyKey: id('other'), at: 5 }] }), /active/);
  assert.throws(() => simulateResponse(result, { rollbacks: [{ idempotencyKey: decision.idempotencyKey, at: decision.expiresAt }] }), /active/);
  result.decisions.push({ ...decision, at: 4 });
  assert.throws(() => simulateResponse(result), /Conflicting/);
  result.decisions[1].idempotencyKey = id('other');
  assert.throws(() => simulateResponse(result), /Overlapping/);
});

test('monitor remains empty and large traces retain complete aggregate counts', () => {
  const monitored = simulateResponse(replay([0], 'monitor'));
  assert.deepEqual(monitored.records, []);
  const report = simulateResponse(replay(Array.from({ length: 100 }, (_, i) => i * 300000)));
  assert.equal(report.recordCount, 300);
  assert.equal(report.counts.expired, 100);
  assert.equal(report.records.length, 128);
  assert.equal(report.truncated, true);
  assert.equal(report.restored, true);
});
