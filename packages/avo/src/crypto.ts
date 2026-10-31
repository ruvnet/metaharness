// SPDX-License-Identifier: MIT

import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import type { ActionObservation, ActionReceipt, PolicyDecision, VariationAction, VariationCheckpoint } from './types.js';
import type { ReceiptSigner } from './ports.js';

/** No real `ActionReceipt`/`VariationCheckpoint` payload this package produces nests more than a
 *  handful of levels (flat score/decision fields, at most a couple of object-valued fields deep) —
 *  generous enough to never reject a legitimate value, bounded enough to fail fast on a crafted one.
 *  Mirrors `MAX_CANON_DEPTH` in `@metaharness/flywheel`'s `receipts.ts` (2026-10-16, #406). */
const MAX_CANONICAL_DEPTH = 64;

export function canonical(value: unknown, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new Error(`canonical: value exceeds max nesting depth (${MAX_CANONICAL_DEPTH}) — refusing to canonicalize`);
  }
  if (value === undefined) return 'null';
  // Non-finite numbers collapse to the same "null" as `undefined`/`null` under plain
  // `JSON.stringify` — never let that ambiguity reach a signed hash. Mirrors `receipts.ts`'s
  // `canon()` (2026-10-21, #423): this `canonical()` is `@metaharness/avo`'s own independent
  // implementation of the same canonicalization primitive (feeds `sha256`/`transitionHash`/
  // `checkpointHash`/`verifyReceipt`, i.e. the Ed25519 `ActionReceipt`/`VariationCheckpoint` trust
  // chain `GovernedVariationOperator` signs on every action), not a shared import, so it carried
  // the same unguarded gap independently.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('canonical: non-finite numbers cannot be represented in signed JSON');
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key], depth + 1)}`)
    .join(',')}}`;
}

export function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')}`;
}

export function transitionHash(input: {
  previousStateHash: string;
  action: VariationAction;
  observation: ActionObservation;
  policyDecision: PolicyDecision;
  workspaceDigest: string;
}): string {
  return sha256([
    input.previousStateHash,
    input.action,
    input.observation,
    input.policyDecision,
    input.workspaceDigest,
  ]);
}

export class Ed25519ReceiptSigner implements ReceiptSigner {
  constructor(
    readonly id: string,
    private readonly privateKey: KeyObject,
    private readonly publicKey: KeyObject,
  ) {}

  sign(payloadHash: string): string {
    return sign(null, Buffer.from(payloadHash), this.privateKey).toString('base64');
  }

  verify(payloadHash: string, signature: string): boolean {
    return verify(null, Buffer.from(payloadHash), this.publicKey, Buffer.from(signature, 'base64'));
  }
}

export function verifyReceipt(receipt: ActionReceipt, signer: ReceiptSigner): boolean {
  // `transitionHash`/`canonical` now throw on a value that cannot be safely canonicalized (over-depth
  // or non-finite) rather than silently colliding — a receipt carrying such a value cannot be confirmed
  // authentic, so it must fail this check the same as any other mismatch, not escape as an uncaught
  // error from what every caller (`.every(verifyReceipt)`) already treats as a plain boolean predicate.
  try {
    const expected = transitionHash(receipt);
    return expected === receipt.stateHash && signer.verify(receipt.stateHash, receipt.signature);
  } catch {
    return false;
  }
}

export function checkpointHash(checkpoint: Omit<VariationCheckpoint, 'checkpointHash' | 'signature'>): string {
  return sha256(checkpoint);
}
