// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

// A source checkout on Node with type stripping needs no install or build.
// Node 20 and installed packages use the public workspace package entry.
const receiptSource = new URL('../harness/src/receipts.ts', import.meta.url);
const { hash, ReceiptLog } = process.features.typescript && existsSync(receiptSource)
  ? await import(receiptSource.href)
  : await import('@metaharness/harness');

const SCHEMA = 'metaharness.artex.replay-receipt.v1';
const STAGES = 2;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Commit to one validated import and its deterministic policy result. Only
 * digests enter the returned log. Zero cost and latency fields belong to the
 * logical replay and are excluded from performance measurements.
 */
export function createReplayReceipt(bundle, result) {
  if (!bundle || bundle.version !== 1 || !SHA256.test(bundle.sourceSha256) ||
      typeof bundle.tenant !== 'string' || typeof bundle.caseId !== 'string' ||
      !Array.isArray(bundle.events) ||
      (Object.hasOwn(bundle, 'findings') && !Array.isArray(bundle.findings)) ||
      !result || typeof result !== 'object') {
    throw new TypeError('Expected a validated evidence bundle and its replay result');
  }
  const identity = { tenant: bundle.tenant, caseId: bundle.caseId, version: bundle.version };
  const raw = { ...identity, sourceSha256: bundle.sourceSha256 };
  const normalized = { ...identity, events: bundle.events };
  if (Object.hasOwn(bundle, 'findings')) normalized.findings = bundle.findings;
  const runId = hash({ schema: SCHEMA, raw });
  const metadata = { runId, agent: 'artex-defense', model: 'none', costUsd: 0, latencyMs: 0, verdict: 'pass' };
  const log = new ReceiptLog();
  log.append({ ...metadata, step: 'import', input: raw, output: normalized });
  const tail = log.append({ ...metadata, step: 'evaluate', input: normalized, output: result });
  return { schema: SCHEMA, ...log.toJSON(), tailSha256: tail.thisHash };
}

/**
 * Supply the tail from an independently retained checkpoint and a fresh replay
 * of the trusted source. An unauthenticated peer can rebuild a valid hash chain.
 */
export function verifyReplayReceipt(artifact, bundle, result, expectedTailSha256) {
  if (typeof expectedTailSha256 !== 'string' || !SHA256.test(expectedTailSha256) ||
      artifact?.schema !== SCHEMA || artifact.tailSha256 !== expectedTailSha256 ||
      !Array.isArray(artifact.receipts) || artifact.receipts.length !== STAGES) {
    return false;
  }
  const replayed = createReplayReceipt(bundle, result);
  if (!isDeepStrictEqual(artifact, replayed)) return false;
  ReceiptLog.fromJSON(artifact); // fromJSON verifies every chain link.
  return true;
}

// The CLI supplies fresh policy results from the original pinned evidence.
// Compare the complete report bytes, including key order and the final newline.
export function verifyReplayReport(raw, bundle, result, expectedTailSha256) {
  if (typeof expectedTailSha256 !== 'string' || !SHA256.test(expectedTailSha256)) return false;
  const receipt = createReplayReceipt(bundle, result);
  if (receipt.tailSha256 !== expectedTailSha256) return false;
  const expected = JSON.stringify({version: 1, result, receipt}) + '\n';
  if (!raw.equals(Buffer.from(expected))) return false;
  ReceiptLog.fromJSON(receipt);
  return true;
}
