// SPDX-License-Identifier: MIT

import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import type { ActionObservation, ActionReceipt, PolicyDecision, VariationAction, VariationCheckpoint } from './types.js';
import type { ReceiptSigner } from './ports.js';

export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
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
  const expected = transitionHash(receipt);
  return expected === receipt.stateHash && signer.verify(receipt.stateHash, receipt.signature);
}

export function checkpointHash(checkpoint: Omit<VariationCheckpoint, 'checkpointHash' | 'signature'>): string {
  return sha256(checkpoint);
}
