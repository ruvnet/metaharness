// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { MAX_EVENTS } from './ingest.mjs';

const digestPattern = /^[a-f0-9]{64}$/;
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const kinds = new Set(['benign', 'marker', 'decoy_hit', 'credential_change', 'anomalous_use', 'finding']);
const sources = new Set(['edge', 'identity', 'endpoint', 'canary', 'artex']);
const windowMs = 300_000;
const ttlMs = 300_000;
const revision = 'offline-policy-v1';

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Check normalized inputs even when callers invoke the library without the importer.
function validatedEvents(bundle) {
  if (!bundle || bundle.version !== 1 || typeof bundle.tenant !== 'string' || !scopePattern.test(bundle.tenant) ||
      typeof bundle.caseId !== 'string' || !scopePattern.test(bundle.caseId) ||
      typeof bundle.sourceSha256 !== 'string' || !digestPattern.test(bundle.sourceSha256) ||
      !Array.isArray(bundle.events) || bundle.events.length > MAX_EVENTS) {
    throw new Error('Invalid normalized evidence bundle');
  }
  const ids = new Set();
  return bundle.events.map(event => {
    if (!event || typeof event.id !== 'string' || !digestPattern.test(event.id) ||
        typeof event.session !== 'string' || !digestPattern.test(event.session) ||
        !kinds.has(event.kind) || !sources.has(event.source) ||
        (event.source === 'artex') !== (event.kind === 'finding') ||
        !Number.isSafeInteger(event.at) || event.at < 0 || event.at > 253402300799999 ||
        ids.has(event.id)) {
      throw new Error('Invalid or duplicate normalized event');
    }
    ids.add(event.id);
    return { id: event.id, session: event.session, kind: event.kind, at: event.at, source: event.source };
  }).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Replay declared provenance labels in one offline case. Labels do not authenticate
 * a collector. All decisions are advisory and every quarantine is simulated.
 */
export function evaluateCase(bundle, mode = 'monitor', policy = 'candidate') {
  if (!['monitor', 'simulate'].includes(mode) || !['baseline', 'candidate'].includes(policy)) {
    throw new Error('Unknown replay mode or policy');
  }
  const events = validatedEvents(bundle);
  const caseDigest = digest([bundle.tenant, bundle.caseId]);
  const normalizedSha256 = digest([caseDigest, events]);
  const credentials = new Map();
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
      } else if (policy === 'candidate' && event.kind === 'anomalous_use' &&
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
      const key = digest([revision, policy, caseDigest, event.session, rule, evidence]);
      const decision = { sessionRef, rule, at: event.at, evidence, outcome: 'alert' };
      if (mode === 'simulate') {
        decision.outcome = 'would_quarantine';
        decision.expiresAt = event.at + ttlMs;
        decision.idempotencyKey = key;
      }
      decisions.push(decision);
      cooldown.set(event.session, event.at + ttlMs);
    }
    for (let i = start; i < end; i++) {
      const event = events[i];
      if (event.kind === 'credential_change' && event.source === 'identity') {
        credentials.set(event.session, event);
      }
    }
    start = end;
  }
  const receipt = {
    version: 1, revision, policy, mode, caseDigest, inputSha256: bundle.sourceSha256, normalizedSha256,
    summary: { events: events.length, observations, alerts: decisions.length,
      simulatedQuarantines: mode === 'simulate' ? decisions.length : 0 },
    decisions
  };
  return { ...receipt, receiptSha256: digest(receipt) };
}

// The trusted digest must come from a separately retained manifest. A digest
// carried only alongside a submitted receipt does not identify a trusted run.
export function verifyReplay(receipt, bundle, trustedDigest) {
  if (typeof trustedDigest !== 'string' || !digestPattern.test(trustedDigest) ||
      receipt?.receiptSha256 !== trustedDigest) return false;
  try {
    const { receiptSha256, ...body } = receipt;
    return receiptSha256 === digest(body) &&
      evaluateCase(bundle, receipt.mode, receipt.policy).receiptSha256 === trustedDigest;
  } catch {
    return false;
  }
}
