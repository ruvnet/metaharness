// SPDX-License-Identifier: MIT
import crypto from 'node:crypto';

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

// One-shot hashing avoids a stream object per small reference on Node 20.12+.
// Retain the original implementation for the earlier supported Node 20 releases.
const sha256 = typeof crypto.hash === 'function'
  ? bytes => crypto.hash('sha256', bytes, 'hex')
  : bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function scopedEvents(scope, cacheSessions) {
  // Every component below passed an ASCII identifier or enum check. This is
  // the exact JSON array encoding of the v1 references, including the scope.
  const prefix = JSON.stringify(['artex-evidence-v1', scope.tenant, scope.caseId]).slice(0, -1);
  const eventPrefix = prefix + ',"event","';
  const sessionPrefix = prefix + ',"session","';
  // CSV assigns a distinct session to each finding, so it has no reuse.
  const sessions = cacheSessions ? new Map() : undefined;
  return (id, session, kind, at, source) => {
    let sessionRef = sessions?.get(session);
    if (sessionRef === undefined) {
      sessionRef = sha256(sessionPrefix + session + '"]');
      sessions?.set(session, sessionRef);
    }
    return {
      id: sha256(eventPrefix + source + '","' + id + '"]'),
      session: sessionRef, kind, at, source,
    };
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
      let escaped = false;
      while (++i < text.length && text[i] !== '"') {
        if (text[i] === '\\') {
          escaped = true;
          i++;
        }
      }
      requireValue(i < text.length, 'Invalid evidence JSON');
      let next = i + 1;
      while (text[next] === ' ' || text[next] === '\t' || text[next] === '\r' || text[next] === '\n') next++;
      if (text[next] === ':') {
        requireValue(i - start < 64, 'JSON key exceeds limit');
        let key = text.slice(start + 1, i);
        if (escaped || /[\u0000-\u001f]/.test(key)) {
          try { key = JSON.parse(text.slice(start, i + 1)); }
          catch { throw new TypeError('Invalid JSON key'); }
        }
        const fields = stack[stack.length - 1];
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
  const scopedEvent = scopedEvents(scope, true);
  const events = data.events.map(event => {
    requireValue(exactFields(event, ['id', 'session', 'kind', 'at', 'source']), 'Invalid event fields');
    const { id, session, kind, at, source } = event;
    requireValue(safeId(id) && safeId(session), 'Invalid event identifier');
    requireValue(Number.isSafeInteger(at) && at >= 0 && at <= timestampMax, 'Invalid event time');
    requireValue(kinds.has(kind) && sources.has(source) && (kind === 'finding') === (source === 'artex'),
      'Invalid event kind or source');
    return scopedEvent(id, session, kind, at, source);
  });
  return { events };
}

// Strict RFC-style CSV. Quoted fields may include commas, line feeds and
// doubled quotes. Reject malformed rows before interpreting any column.
function* csvRows(text) {
  // Advance from delimiter to delimiter so long narratives are sliced once.
  // Quoted fields enforce the size cap on their decoded UTF-16 length.
  const delimiter = /[",\r\n]/g;
  let row = [], count = 0, i = 0;
  while (i < text.length || row.length) {
    let field;
    if (text[i] === '"') {
      const start = ++i;
      let pairs = 0;
      for (;;) {
        const end = text.indexOf('"', i);
        const length = (end < 0 ? text.length : end) - start - pairs;
        requireValue(length <= MAX_CSV_FIELD, 'CSV field exceeds limit');
        requireValue(end >= 0, 'Unclosed CSV quote');
        i = end + 1;
        if (text[i] !== '"') {
          field = text.slice(start, end);
          if (pairs) field = field.replaceAll('""', '"');
          break;
        }
        requireValue(length < MAX_CSV_FIELD, 'CSV field exceeds limit');
        pairs++;
        i++;
      }
    } else {
      const start = i;
      delimiter.lastIndex = start;
      i = delimiter.test(text) ? delimiter.lastIndex - 1 : text.length;
      requireValue(i - start <= MAX_CSV_FIELD, 'CSV field exceeds limit');
      field = text.slice(start, i);
    }
    const separator = text[i++];
    requireValue(separator !== '"' && (separator === undefined || separator === ',' ||
      separator === '\n' || separator === '\r'), 'Invalid CSV quoting');
    if (separator === '\r') requireValue(text[i++] === '\n', 'Invalid CSV line ending');
    requireValue(row.length < reviewedHeader.length, 'CSV has too many columns');
    row.push(field);
    if (separator !== ',') {
      requireValue(++count <= MAX_EVENTS + 1, 'Too many CSV rows');
      yield row;
      row = [];
    }
  }
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
  const scopedEvent = scopedEvents(scope, false);
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
    const event = scopedEvent(id, 'finding.' + id, 'finding', csvTime(row[idx['Found At']]), 'artex');
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
