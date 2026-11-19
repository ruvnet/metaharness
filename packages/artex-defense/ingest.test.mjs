// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { importEvidence, MAX_INPUT_BYTES } from './ingest.mjs';

const scope = { tenant: 'demo', caseId: 'pilot' };
const options = { ...scope, format: 'json' };
const sample = { id: 'private-key-shaped-reference', session: 'subject.9', kind: 'marker', at: 1700000000000, source: 'edge' };
const envelope = events => JSON.stringify({ version: 1, ...scope, events });
const digest = text => createHash('sha256').update(text).digest('hex');

const header = ['ID','Name','Class','Severity','Status','Task','Found At','Summary','Traffic Evidence Count','Traffic Evidence IDs'];
const fields = ['42','"Free text, with a comma"','test','High','pending','private-task','2026-11-17 12:23:34',
  '"First line\nSecond ""quoted"" confidential line"','2','"12,13"'];
const csv = (columns = header, row = fields) => '\uFEFF' + columns.join(',') + '\r\n' + row.join(',') + '\r\n';
const importCsv = bytes => importEvidence(bytes, { ...scope, format: 'csv', expectedSha256: digest(bytes) });

test('both pinned upstream CSV layouts yield correlated references without copying narrative or evidence IDs', () => {
  for (const bytes of [csv(), csv([...header.slice(0,5),'Report Stage',...header.slice(5)],
    [...fields.slice(0,5),'draft',...fields.slice(5)])]) {
    const result = importCsv(bytes);
    assert.equal(result.sourceSha256, digest(bytes));
    assert.deepEqual(result.findings, [{ id: result.events[0].id, severity: 'high', trafficEvidenceCount: 2 }]);
    assert.equal(result.events[0].source, 'artex');
    assert.equal(result.events[0].kind, 'finding');
    assert.equal(result.events[0].at, Date.UTC(2026,10,17,12,23,34));
    assert.doesNotMatch(JSON.stringify(result), /First line|confidential|private-task|12,13/);
  }
});

test('CSV requires separately pinned bytes and rejects malformed references, quotes and shape changes', () => {
  const bytes = csv();
  const csvOptions = { ...scope, format: 'csv' };
  assert.throws(() => importEvidence(bytes, csvOptions), /digest/);
  assert.throws(() => importEvidence(bytes + ' ', { ...csvOptions, expectedSha256: digest(bytes) }), /digest/);
  for (const bad of [bytes.replace('"12,13"', '"12,13'), bytes.replace('"12,13"', '12'),
    bytes.replace('2026-11-17','2026-11-31'),bytes.replace('Severity','Secret'),
    bytes.replace('"Free text, with a comma"', '"x"oops'), bytes + fields.join(',')]) {
    assert.throws(() => importCsv(bad));
  }
});

test('JSON preserves scoped correlation across telemetry sources while pseudonymizing input identifiers', () => {
  const data = envelope([sample, { ...sample, source:'identity' }]);
  const result = importEvidence(data,options);
  const [a,b] = result.events;
  assert.notEqual(a.id,b.id);
  assert.equal(a.session,b.session);
  assert.doesNotMatch(JSON.stringify(result), /private-key-shaped-reference|subject\.9/);
  const other = { ...options, caseId: 'other' };
  assert.notEqual(a.session,importEvidence(data.replace('pilot','other'),other).events[0].session);
});

test('malformed, ambiguous, unpublished, out of scope and oversized evidence fails atomically', () => {
  const good = envelope([sample]);
  for (const bad of [good.replace('"tenant":"demo"','"tenant":"foreign","ten\\u0061nt":"demo"'),
    good.replace('"demo"', '"other"'), good.replace('pilot','other'),good.replace('"version":1','"version":2'),
    good.replace('"events"','"__proto__":{},"events"'),envelope([sample,sample]), envelope([{...sample, at:'123'}]),
    envelope([{...sample, kind:'grant'}]),envelope([{...sample, source:'artex'}]),envelope([{...sample,kind:'finding'}]),
    envelope([{...sample, secret:'abc123'}]),new Uint8Array(MAX_INPUT_BYTES+1),Buffer.from([0xff]),
    '[['.repeat(500), '"unterminated']) {
    assert.throws(() => importEvidence(bad,options));
  }
});
