// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { importEvidence, MAX_EVENTS } from './ingest.mjs';
import { evaluateCase, verifyReplay } from './replay.mjs';

const scope = { tenant: 'fixture-tenant', caseId: 'case-1' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const event = (id, kind, source, at, session = 's1') => ({ id, session, kind, source, at });
const envelope = events => JSON.stringify({ version: 1, ...scope, events });
const json = events => importEvidence(envelope(events), { ...scope, format: 'json' });
const simulate = events => evaluateCase(json(events), 'simulate');

const change = event('record-1', 'credential_change', 'identity', 100);
const use = event('record-2', 'anomalous_use', 'edge', 120);
const honey = event('record-3', 'decoy_hit', 'canary', 140);

test('overlapping identifiers in different tenants or cases produce different references', () => {
  const refs = new Set();
  for (const context of [scope, { ...scope, tenant: 'other' }, { ...scope, caseId: 'other' }]) {
    const bytes = JSON.stringify({ version: 1, ...context, events: [honey] });
    const result = evaluateCase(importEvidence(bytes, { ...context, format: 'json' }), 'simulate');
    assert.equal(result.decisions.length, 1);
    refs.add(result.decisions[0].sessionRef);
  }
  assert.equal(refs.size, 3);
  assert.throws(() => importEvidence(envelope([honey]), { ...scope, tenant: 'other', format: 'json' }));
});

test('correlation requires an independent later signal within the same session and window', () => {
  for (const next of [
    { ...use, session: 's2' },
    { ...use, source: 'identity' },
    { ...use, at: change.at },
    { ...use, at: change.at - 1 },
    { ...use, at: change.at + 300001 },
  ]) {
    assert.deepEqual(simulate([change, next]).decisions, []);
  }
  const later = { ...use, at: change.at + 300000 };
  assert.equal(simulate([change, later]).decisions.length, 1);
  // Reverse file order changes input provenance, while the replayed action stays the same.
  assert.deepEqual(simulate([later, change]).decisions, simulate([change, later]).decisions);
  assert.equal(evaluateCase(json([change, use]), 'simulate', 'baseline').decisions.length, 0);
});

test('the policy uses collector source and cannot quarantine from a marker, claim, or finding', () => {
  for (const item of [
    event('x', 'marker', 'canary', 150),
    event('x', 'decoy_hit', 'edge', 150),
    event('x', 'finding', 'artex', 150),
  ]) assert.deepEqual(simulate([item]).decisions, []);
  assert.throws(() => json([event('x', 'decoy_hit', 'artex', 150)]));
  assert.throws(() => evaluateCase(json([honey]), 'enforce'));
});

test('cooldown suppresses repeated indications until expiry, and monitor creates only an alert', () => {
  const after = offset => ({ ...honey, id: 'later-' + offset, at: honey.at + offset });
  const trace = [honey, after(1), after(299999), after(300000)];
  const simulated = simulate(trace);
  assert.deepEqual(simulated.decisions.map(d => d.at), [honey.at, honey.at + 300000]);
  assert.equal(new Set(simulated.decisions.map(d => d.idempotencyKey)).size, 2);
  const monitored = evaluateCase(json(trace), 'monitor');
  assert.equal(monitored.summary.simulatedQuarantines, 0);
  assert.ok(monitored.decisions.every(d => d.outcome === 'alert' && !Object.hasOwn(d, 'idempotencyKey')));
});

test('source identity disambiguates collector local IDs and rejects same collector repeats', () => {
  assert.throws(() => json([change, { ...change, at: 90, session: 's2' }]));
  assert.equal(simulate([change, { ...use, id: change.id }]).decisions.length, 1);
});

test('verification requires the expected digest and the same source bytes', () => {
  const bundle = json([change, use]);
  const receipt = evaluateCase(bundle);
  assert.equal(verifyReplay(receipt, bundle, receipt.receiptSha256), true);
  assert.equal(verifyReplay(receipt, bundle), false);
  assert.equal(verifyReplay({ ...receipt, decisions: [] }, bundle, receipt.receiptSha256), false);
  assert.equal(verifyReplay(receipt, json([use, change]), receipt.receiptSha256), false);
});

test('a critical finding and its traffic references remain inert during response simulation', () => {
  const bytes = 'ID,Name,Class,Severity,Status,Task,Found At,Summary,Traffic Evidence Count,Traffic Evidence IDs\n' +
    '73,Example,example,critical,pending,fixture,2026-11-10 17:31:01,"private narrative",2,"14,18"\n';
  const bundle = importEvidence(bytes, { ...scope, format: 'csv', expectedSha256: sha256(bytes) });
  const result = evaluateCase(bundle, 'simulate');
  assert.equal(result.summary.observations, 1);
  assert.equal(result.summary.simulatedQuarantines, 0);
  assert.deepEqual(result.decisions, []);
  assert.equal(verifyReplay(result, bundle, result.receiptSha256), true);
});

test('all supported normalized input lengths can reach the policy evaluator', () => {
  const events = Array.from({ length: MAX_EVENTS }, (_, n) => event('m' + n, 'benign', 'edge', 100 + n));
  assert.equal(simulate(events).summary.events, MAX_EVENTS);
  assert.throws(() => json([...events, event('last', 'benign', 'edge', 1)]));
});
