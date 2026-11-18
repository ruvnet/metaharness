// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';

export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_EVENTS = 10_000;
const MAX_CSV_FIELD = 64 * 1024;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const timestampMax = 253402300799999;
const kinds = new Set(['benign', 'marker', 'decoy_hit', 'credential_change', 'anomalous_use', 'finding']);
const sources = new Set(['edge', 'identity', 'endpoint', 'canary', 'artex']);
const severities = new Set(['critical', 'high', 'medium', 'low', 'info', 'informational', 'unknown']);

// FindingsCSV in upstream report/findings.go, first v0.6.0 and then 9355d83.
const releasedHeader = ['ID', 'Name', 'Class', 'Severity', 'Status', 'Task', 'Found At',
  'Summary', 'Traffic Evidence Count', 'Traffic Evidence IDs'];
const reviewedHeader = [...releasedHeader.slice(0, 5), 'Report Stage', ...releasedHeader.slice(5)];

function requireValue(condition, message) {
  if (!condition) throw new TypeError(message);
}

function safeId(value) {
  return typeof value === 'string' && identifier.test(value);
}

function exactFields(object, fields) {
  return object !== null && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).length === fields.length
    && fields.every(key => Object.hasOwn(object, key));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function reference(scope, type, ...keys) {
  return sha256(JSON.stringify(['artex-evidence-v1', scope.tenant, scope.caseId, type, ...keys]));
}

function scopedEvent(scope, id, session, kind, at, source) {
  return {
    id: reference(scope, 'event', source, id),
    session: reference(scope, 'session', session),
    kind, at, source,
  };
}

// JSON.parse accepts repeated keys. Reject ambiguous inputs so that a second
// parser cannot interpret the scope or an event differently. The scan also bounds depth
// and field count before allocating the parsed object tree.
function checkObjectKeys(text) {
  const stack = [];
  let separators = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ',') {
      requireValue(++separators <= MAX_EVENTS * 5 + 4, 'Too many JSON values');
    } else if (ch === '{' || ch === '[') {
      requireValue(stack.length < 4, 'JSON nesting exceeds limit');
      stack.push(ch === '{' ? new Set() : null);
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === '"') {
      const start = i;
      while (++i < text.length && text[i] !== '"') if (text[i] === '\\') i++;
      requireValue(i < text.length, 'Invalid evidence JSON');
      let next = i + 1;
      while (/^[\t\n\r ]$/.test(text[next] ?? '')) next++;
      if (text[next] === ':') {
        requireValue(i - start < 64, 'JSON key exceeds limit');
        let key;
        try { key = JSON.parse(text.slice(start, i + 1)); }
        catch { throw new TypeError('Invalid JSON key'); }
        const fields = stack.at(-1);
        requireValue(fields instanceof Set && !fields.has(key), 'Duplicate JSON key');
        fields.add(key);
      }
    }
  }
}

export function parseEvidenceJSON(text) {
  checkObjectKeys(text);
  let data;
  try { data = JSON.parse(text); } catch { throw new TypeError('Invalid evidence JSON'); }
  return data;
}

function importJson(text, scope) {
  const data = parseEvidenceJSON(text);
  requireValue(exactFields(data, ['version', 'tenant', 'caseId', 'events']) && data.version === 1,
    'Unsupported evidence envelope');
  requireValue(data.tenant === scope.tenant && data.caseId === scope.caseId, 'Evidence scope mismatch');
  requireValue(Array.isArray(data.events) && data.events.length <= MAX_EVENTS, 'Invalid event count');
  const events = data.events.map(event => {
    requireValue(exactFields(event, ['id', 'session', 'kind', 'at', 'source']), 'Invalid event fields');
    const { id, session, kind, at, source } = event;
    requireValue(safeId(id) && safeId(session), 'Invalid event identifier');
    requireValue(Number.isSafeInteger(at) && at >= 0 && at <= timestampMax, 'Invalid event time');
    requireValue(kinds.has(kind) && sources.has(source) && (kind === 'finding') === (source === 'artex'),
      'Invalid event kind or source');
    return scopedEvent(scope, id, session, kind, at, source);
  });
  return { events };
}

// Strict RFC-style CSV. Quoted fields may include commas, line feeds and
// doubled quotes. Reject malformed rows before interpreting any column.
function* csvRows(text) {
  let row = [], field = '', quoted = false, closedQuote = false, count = 0;
  function endField() {
    requireValue(row.length < reviewedHeader.length, 'CSV has too many columns');
    row.push(field);
    field = '';
    closedQuote = false;
  }
  function endRow() {
    endField();
    requireValue(++count <= MAX_EVENTS + 1, 'Too many CSV rows');
    const finished = row;
    row = [];
    return finished;
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closedQuote = true; }
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r') {
        requireValue(text[i + 1] === '\n', 'Invalid CSV line ending');
        i++;
      }
      yield endRow();
    } else if (ch === '"' && !field && !closedQuote) {
      quoted = true;
    } else {
      requireValue(!closedQuote && ch !== '"', 'Invalid CSV quoting');
      field += ch;
    }
    requireValue(field.length <= MAX_CSV_FIELD, 'CSV field exceeds limit');
  }
  requireValue(!quoted, 'Unclosed CSV quote');
  if (row.length || field.length || closedQuote) yield endRow();
}

function csvTime(value) {
  requireValue(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value), 'Invalid finding time');
  // Upstream omits the zone. UTC is an explicit normalization convention for
  // observation-only finding events, not evidence of causal ordering.
  const iso = value.replace(' ', 'T') + '.000Z';
  const at = Date.parse(iso);
  requireValue(Number.isFinite(at) && at >= 0 && new Date(at).toISOString() === iso, 'Invalid finding time');
  return at;
}

function importCsv(text, scope) {
  const rows = csvRows(text);
  const header = rows.next().value;
  requireValue(header && [releasedHeader, reviewedHeader].some(shape =>
    shape.length === header.length && shape.every((field, i) => field === header[i])),
    'Unsupported ARTEX CSV header');
  const idx = Object.fromEntries(header.map((name, i) => [name, i]));
  const events = [], findings = [];
  for (const row of rows) {
    requireValue(row.length === header.length, 'Invalid CSV column count');
    const id = row[idx.ID], rawCount = row[idx['Traffic Evidence Count']];
    requireValue(/^[1-9]\d{0,18}$/.test(id) && /^(?:0|[1-9]\d{0,5})$/.test(rawCount),
      'Invalid finding identifier or evidence count');
    const rawIds = row[idx['Traffic Evidence IDs']];
    const evidenceIds = rawIds ? rawIds.split(',') : [];
    requireValue(Number(rawCount) === evidenceIds.length && evidenceIds.every(ref => /^[1-9]\d{0,18}$/.test(ref)),
      'Invalid traffic evidence references');
    const event = scopedEvent(scope, id, 'finding.' + id, 'finding', csvTime(row[idx['Found At']]), 'artex');
    const severity = row[idx.Severity].toLowerCase();
    events.push(event);
    findings.push({
      id: event.id, severity: severities.has(severity) ? severity : 'unknown',
      trafficEvidenceCount: evidenceIds.length,
    });
  }
  return { events, findings };
}

/**
 * The caller supplies tenant and case from its trusted context. CSV has no
 * embedded tenant, so the caller must also supply the expected original byte
 * digest from its own scoped manifest. File contents establish no authority.
 */
export function importEvidence(input, { format, tenant, caseId, expectedSha256 } = {}) {
  requireValue(safeId(tenant) && safeId(caseId), 'Invalid import scope');
  requireValue(format === 'json' || format === 'csv', 'Unsupported import format');
  requireValue(typeof input === 'string' || input instanceof Uint8Array, 'Expected UTF-8 text or bytes');
  const size = typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength;
  requireValue(size > 0 && size <= MAX_INPUT_BYTES, 'Evidence input exceeds size bounds');
  const bytes = Buffer.from(input);
  const sourceSha256 = sha256(bytes);
  if (format === 'csv' || expectedSha256 !== undefined) {
    requireValue(typeof expectedSha256 === 'string' && sha256Pattern.test(expectedSha256)
      && sourceSha256 === expectedSha256, 'Expected source digest missing or mismatched');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new TypeError('Invalid UTF-8 evidence'); }
  requireValue(!text.includes('\0'), 'Invalid evidence text');
  const scope = { tenant, caseId };
  const imported = format === 'csv' ? importCsv(text, scope) : importJson(text, scope);
  const ids = new Set(imported.events.map(event => event.id));
  requireValue(ids.size === imported.events.length, 'Duplicate source event identifier');
  return { version: 1, ...scope, sourceSha256, ...imported };
}
