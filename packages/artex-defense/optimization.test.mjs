// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { importEvidence, parseEvidenceJSON } from './ingest.mjs';
import { evaluateCase, evaluatePolicies, verifyReplay } from './replay.mjs';

const scope = { tenant: 'fixtures', caseId: 'pair' };
const event = (id, kind, at, source, session = 'a') => ({ id, kind, at, source, session });
function importTrace() {
  const events = [
    event('late', 'anomalous_use', 13, 'edge'),
    event('use', 'anomalous_use', 10, 'endpoint'),
    event('canary', 'decoy_hit', 13, 'canary', 'b'),
    event('changed', 'credential_change', 10, 'identity'),
  ];
  return importEvidence(JSON.stringify({ version: 1, ...scope, events }), { format: 'json', ...scope });
}

// Receipts captured from the standalone policies at 325eb57 before introducing paired replay.
const pins = {
  monitor: {
    baseline: '79a5a9b2834a8ed7e2f18272b8261e07e846762fb1fcd2537261cf99ab780730',
    candidate: '76000bb81d1d295c292736d85d3cfb80042c69603730d08c20500720c8841f5f',
  },
  simulate: {
    baseline: '3dd5ea29bea5f9fcae65dbb27967c75eaeb9f7954d6e60d5b5801ab0b06020b7',
    candidate: '080b868fee8eb6a0f9eabf5a2020c7cf5f3fbe37367698881323b244a1796dbf',
  },
};

test('paired and standalone replay preserve the original receipts for unordered, tied events', () => {
  const bundle = importTrace();
  const original = structuredClone(bundle);
  for (const [mode, policies] of Object.entries(pins)) {
    const pair = evaluatePolicies(bundle, mode);
    for (const [policy, pin] of Object.entries(policies)) {
      assert.deepEqual(pair[policy], evaluateCase(bundle, mode, policy));
      assert.equal(pair[policy].receiptSha256, pin);
      assert.ok(verifyReplay(pair[policy], bundle, pin));
    }
  }
  assert.deepEqual(bundle, original);
});

test('each paired invocation revalidates mutable evidence and recomputes both receipts', () => {
  const bundle = importTrace();
  const first = evaluatePolicies(bundle);
  bundle.events[0].kind = 'benign';
  const second = evaluatePolicies(bundle);
  assert.equal(second.candidate.summary.alerts, 1);
  for (const policy of ['baseline', 'candidate']) {
    assert.notEqual(second[policy].normalizedSha256, first[policy].normalizedSha256);
    assert.equal(verifyReplay(first[policy], bundle, first[policy].receiptSha256), false);
  }
  bundle.events[0].id = bundle.events[1].id;
  assert.throws(() => evaluatePolicies(bundle), /duplicate/i);
});

test('escaped JSON keys use their decoded identity within each object', () => {
  assert.deepEqual(parseEvidenceJSON(String.raw`[{"\u00e9":1},{"é":2}]`), [{ é: 1 }, { é: 2 }]);
  assert.throws(() => parseEvidenceJSON(String.raw`[{"é":1,"\u00e9":2}]`), /Duplicate JSON key/);
});

test('the CSV field limit counts decoded text including escaped quotes and UTF-16 pairs', () => {
  const header = 'ID,Name,Class,Severity,Status,Task,Found At,Summary,Traffic Evidence Count,Traffic Evidence IDs';
  const make = summary => {
    const body = header + '\r\n1,x,x,low,x,x,2026-11-10 17:31:01,"' + summary + '",0,';
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    return importEvidence(body, { ...scope, format: 'csv', expectedSha256 });
  };
  const boundary = 'x'.repeat(65533) + '🟣""';
  assert.equal(make(boundary).findings.length, 1);
  assert.throws(() => make(boundary + 'x'), /CSV field exceeds limit/);
});
