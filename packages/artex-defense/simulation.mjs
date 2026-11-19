// SPDX-License-Identifier: MIT
// A virtual clock drives every transition. No resources outside this invocation are touched.
const digest = /^[a-f0-9]{64}$/;
const validRef = value => typeof value === 'string' && digest.test(value);
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const maxDecisions = 10000;
const maxRecords = 128;
const maxTtlMs = 300000;

/**
 * Replay quarantine intents against an initially empty in-memory session set.
 * Rollback points occur strictly inside the leased interval. Releases run before
 * a subsequent lease starting at the same time. The clock drains all timers.
 */
export function simulateResponse(result, { rollbacks = [] } = {}) {
  if (result?.version !== 1 || !['monitor', 'simulate'].includes(result.mode) ||
      !validRef(result.caseDigest) || !Array.isArray(result.decisions) ||
      result.decisions.length > maxDecisions || !Array.isArray(rollbacks) || rollbacks.length > maxDecisions) {
    throw new TypeError('Invalid simulation input');
  }
  const counts = { intents: 0, applied: 0, expired: 0, rolledBack: 0, duplicates: 0 };
  const leases = new Map();
  for (const decision of result.decisions) {
    if (result.mode === 'monitor' && decision?.outcome === 'alert') continue;
    if (result.mode !== 'simulate' || decision?.outcome !== 'would_quarantine' ||
        !validRef(decision.sessionRef) || !validRef(decision.idempotencyKey) ||
        !validTime(decision.at) || !validTime(decision.expiresAt) ||
        decision.expiresAt <= decision.at || decision.expiresAt - decision.at > maxTtlMs) {
      throw new TypeError('Invalid simulated quarantine intent');
    }
    const { idempotencyKey, sessionRef, at, expiresAt } = decision;
    const prior = leases.get(idempotencyKey);
    if (prior) {
      if (prior.sessionRef !== sessionRef || prior.at !== at || prior.expiresAt !== expiresAt) {
        throw new Error('Conflicting idempotency key');
      }
      counts.duplicates++;
      continue;
    }
    leases.set(idempotencyKey, { idempotencyKey, sessionRef, at, expiresAt });
  }
  const reversals = new Map();
  for (const rollback of rollbacks) {
    const lease = leases.get(rollback?.idempotencyKey);
    if (!lease || !validTime(rollback.at) || rollback.at <= lease.at || rollback.at >= lease.expiresAt) {
      throw new Error('Rollback must refer to an active simulated lease');
    }
    const prior = reversals.get(lease.idempotencyKey);
    if (prior !== undefined && prior !== rollback.at) throw new Error('Conflicting rollback times');
    if (prior !== undefined) counts.duplicates++;
    reversals.set(lease.idempotencyKey, rollback.at);
  }

  const timeline = [];
  for (const lease of leases.values()) {
    const release = reversals.get(lease.idempotencyKey);
    timeline.push({ lease, at: lease.at, kind: 'start' });
    timeline.push({ lease, at: release ?? lease.expiresAt, kind: release === undefined ? 'expired' : 'rolledBack' });
  }
  timeline.sort((a, b) => a.at - b.at || Number(a.kind === 'start') - Number(b.kind === 'start') ||
    (a.lease.idempotencyKey < b.lease.idempotencyKey ? -1 : a.lease.idempotencyKey > b.lease.idempotencyKey ? 1 : 0));
  const active = new Map();
  const records = [];
  let recordCount = 0;
  function record(kind, { at, lease }) {
    counts[kind]++;
    recordCount++;
    if (records.length < maxRecords) {
      const type = kind === 'intents' ? 'intent' : kind;
      records.push({ type, at, sessionRef: lease.sessionRef, idempotencyKey: lease.idempotencyKey });
    }
  }
  for (const item of timeline) {
    const { sessionRef, idempotencyKey } = item.lease;
    if (item.kind === 'start') {
      if (active.has(sessionRef)) throw new Error('Overlapping simulated leases for one session');
      record('intents', item);
      active.set(sessionRef, idempotencyKey);
      record('applied', item);
    } else {
      if (active.get(sessionRef) !== idempotencyKey) throw new Error('Simulated release lost its lease');
      active.delete(sessionRef);
      record(item.kind, item);
    }
  }
  return { version: 1, mode: result.mode, caseDigest: result.caseDigest, counts,
    recordCount, records, truncated: recordCount > records.length,
    finalActive: active.size, restored: active.size === 0 && counts.applied === counts.expired + counts.rolledBack };
}
