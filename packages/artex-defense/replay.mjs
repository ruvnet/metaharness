// SPDX-License-Identifier: MIT
import crypto from 'node:crypto';
import { MAX_EVENTS } from './ingest.mjs';

const hexDigit = new Uint8Array(128);
for (const char of '0123456789abcdef') hexDigit[char.charCodeAt(0)] = 1;

function isDigest(value) {
  if (typeof value !== 'string' || value.length !== 64) return false;
  for (let i = 0; i < value.length; i++) {
    if (!hexDigit[value.charCodeAt(i)]) return false;
  }
  return true;
}

const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const kinds = new Set(['benign', 'marker', 'decoy_hit', 'credential_change', 'anomalous_use', 'finding']);
const sources = new Set(['edge', 'identity', 'endpoint', 'canary', 'artex']);
const windowMs = 300_000;
const ttlMs = 300_000;
const revision = 'offline-policy-v1';

// crypto.hash is available from Node 20.12. Keep the streaming fallback for earlier Node 20.
const hashText = crypto.hash
  ? text => crypto.hash('sha256', text, 'hex')
  : text => crypto.createHash('sha256').update(text).digest('hex');

function digest(value) {
  return hashText(JSON.stringify(value));
}

function compareEvents(a, b) {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Build a fresh snapshot even when callers bypass the importer or reuse a mutable bundle.
function prepareCase(bundle) {
  if (!bundle) throw new Error('Invalid normalized evidence bundle');
  const { version, tenant, caseId, sourceSha256, events: input } = bundle;
  const length = Array.isArray(input) ? input.length : -1;
  if (version !== 1 || typeof tenant !== 'string' || !scopePattern.test(tenant) ||
      typeof caseId !== 'string' || !scopePattern.test(caseId) || !isDigest(sourceSha256) ||
      !Number.isInteger(length) || length < 0 || length > MAX_EVENTS) {
    throw new Error('Invalid normalized evidence bundle');
  }
  const ids = new Set();
  const events = new Array(length);
  let ordered = true;
  for (let i = 0; i < events.length; i++) {
    const event = input[i];
    if (!event) throw new Error('Invalid or duplicate normalized event');
    const { id, session, kind, at, source } = event;
    if (!isDigest(id) || !isDigest(session) || !kinds.has(kind) || !sources.has(source) ||
        (source === 'artex') !== (kind === 'finding') || !Number.isSafeInteger(at) ||
        at < 0 || at > 253402300799999 || ids.has(id)) {
      throw new Error('Invalid or duplicate normalized event');
    }
    ids.add(id);
    events[i] = { id, session, kind, at, source };
    if (ordered && i > 0 && compareEvents(events[i - 1], events[i]) > 0) ordered = false;
  }
  if (!ordered) events.sort(compareEvents);
  const caseDigest = digest([tenant, caseId]);
  return { events, caseDigest, sourceSha256, normalizedSha256: digest([caseDigest, events]) };
}

function checkMode(mode) {
  if (mode !== 'monitor' && mode !== 'simulate') throw new Error('Unknown replay mode or policy');
}

/**
 * Replay declared provenance labels in one offline case. Labels do not authenticate
 * a collector. All decisions are advisory and every quarantine is simulated.
 */
export function evaluateCase(bundle, mode = 'monitor', policy = 'candidate') {
  checkMode(mode);
  if (policy !== 'baseline' && policy !== 'candidate') throw new Error('Unknown replay mode or policy');
  return evaluatePrepared(prepareCase(bundle), mode, policy);
}

// Only the two policies in this invocation share validation, ordering and input hashes.
export function evaluatePolicies(bundle, mode = 'monitor') {
  checkMode(mode);
  const prepared = prepareCase(bundle);
  return {
    baseline: evaluatePrepared(prepared, mode, 'baseline'),
    candidate: evaluatePrepared(prepared, mode, 'candidate')
  };
}

function evaluatePrepared({ events, caseDigest, sourceSha256, normalizedSha256 }, mode, policy) {
  const credentials = policy === 'candidate' ? new Map() : null;
  const cooldown = new Map();
  const decisions = [];
  let observations = 0;

  // Commit a same-time group after evaluating it. An ambiguous ordering cannot
  // corroborate an event, nor mask an earlier independent credential change.
  for (let start = 0; start < events.length;) {
    let end = start + 1;
    while (end < events.length && events[end].at === events[start].at) end++;
    for (let i = start; i < end; i++) {
      const event = events[i];
      let rule, evidence;
      if (event.kind === 'decoy_hit' && event.source === 'canary') {
        rule = 'bound_decoy';
        evidence = [event.id];
      } else if (credentials && event.kind === 'anomalous_use' &&
          (event.source === 'edge' || event.source === 'endpoint')) {
        const prior = credentials.get(event.session);
        if (prior && event.at - prior.at <= windowMs) {
          rule = 'credential_and_use';
          evidence = [prior.id, event.id];
        }
      }
      if (!rule) {
        if (event.kind !== 'benign') observations++;
        continue;
      }
      if ((cooldown.get(event.session) ?? -1) > event.at) continue;
      const sessionRef = digest([caseDigest, event.session]);
      const decision = { sessionRef, rule, at: event.at, evidence, outcome: 'alert' };
      if (mode === 'simulate') {
        decision.outcome = 'would_quarantine';
        decision.expiresAt = event.at + ttlMs;
        decision.idempotencyKey = digest([revision, policy, caseDigest, event.session, rule, evidence]);
      }
      decisions.push(decision);
      cooldown.set(event.session, event.at + ttlMs);
    }
    if (credentials) {
      for (let i = start; i < end; i++) {
        const event = events[i];
        if (event.kind === 'credential_change' && event.source === 'identity') {
          credentials.set(event.session, event);
        }
      }
    }
    start = end;
  }
  const receipt = {
    version: 1, revision, policy, mode, caseDigest, inputSha256: sourceSha256, normalizedSha256,
    summary: { events: events.length, observations, alerts: decisions.length,
      simulatedQuarantines: mode === 'simulate' ? decisions.length : 0 },
    decisions
  };
  return { ...receipt, receiptSha256: digest(receipt) };
}

// The trusted digest must come from a separately retained manifest. A digest
// carried only alongside a submitted receipt does not identify a trusted run.
export function verifyReplay(receipt, bundle, trustedDigest) {
  if (!isDigest(trustedDigest) ||
      receipt?.receiptSha256 !== trustedDigest) return false;
  try {
    const { receiptSha256, ...body } = receipt;
    return receiptSha256 === digest(body) &&
      evaluateCase(bundle, receipt.mode, receipt.policy).receiptSha256 === trustedDigest;
  } catch {
    return false;
  }
}
