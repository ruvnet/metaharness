// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplayReceipt, verifyReplayReceipt } from './metaharness.mjs';

const bundle = {
  version: 1, sourceSha256: 'a'.repeat(64), tenant: 'fixture-tenant',
  caseId: 'protected-case', events: [{ id: 'e1', session: 'protected-session', kind: 'finding', at: 0 }],
};
const result = { decision: 'observe' };

test('independent replay verifies the two chained stages without publishing input identifiers', () => {
  const artifact = createReplayReceipt(bundle, result);
  const checkpoint = artifact.tailSha256;
  const roundTrip = JSON.parse(JSON.stringify(artifact));
  assert.equal(verifyReplayReceipt(roundTrip, structuredClone(bundle), { ...result }, checkpoint), true);
  assert.equal(roundTrip.receipts[0].outputHash, roundTrip.receipts[1].inputHash);
  assert.doesNotMatch(JSON.stringify(artifact), /fixture-tenant|protected-case|protected-session/);
});

test('truncation, a modified decision, context changes and independently rebuilt evidence are rejected', () => {
  const artifact = createReplayReceipt(bundle, result);
  const checkpoint = artifact.tailSha256;
  const altered = structuredClone(artifact);
  altered.receipts[1].verdict = 'gated';
  assert.equal(verifyReplayReceipt(altered, bundle, result, checkpoint), false);
  assert.equal(verifyReplayReceipt({ ...artifact, receipts: artifact.receipts.slice(0, 1) }, bundle, result, checkpoint), false);
  assert.equal(verifyReplayReceipt(artifact, { ...bundle, tenant: 'another-tenant' }, result, checkpoint), false);
  assert.equal(verifyReplayReceipt(artifact, bundle, { decision: 'allow' }, checkpoint), false);
  const replaced = createReplayReceipt({ ...bundle, sourceSha256: 'b'.repeat(64) }, result);
  assert.equal(verifyReplayReceipt(replaced, bundle, result, checkpoint), false);
  assert.equal(verifyReplayReceipt(artifact, bundle, result), false);
});

test('normalized findings are committed and never exposed in the receipt', () => {
  const imported = { ...bundle, findings: [{ findingRef: 'opaque-fixture-id', severity: 'high' }] };
  const artifact = createReplayReceipt(imported, result);
  assert.equal(verifyReplayReceipt(artifact, imported, result, artifact.tailSha256), true);
  assert.equal(verifyReplayReceipt(artifact, bundle, result, artifact.tailSha256), false);
  const altered = { ...imported, findings: [{ ...imported.findings[0], severity: 'low' }] };
  assert.equal(verifyReplayReceipt(artifact, altered, result, artifact.tailSha256), false);
  assert.doesNotMatch(JSON.stringify(artifact), /opaque-fixture-id/);
});
