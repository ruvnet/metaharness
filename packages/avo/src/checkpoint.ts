// SPDX-License-Identifier: MIT

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { checkpointHash } from './crypto.js';
import type { CheckpointStore, ReceiptSigner } from './ports.js';
import type { VariationCheckpoint, VariationState } from './types.js';

export function createCheckpoint(input: {
  runtimeVersion: string;
  policyVersion: string;
  evaluatorVersion: string;
  state: VariationState;
  signer: ReceiptSigner;
}): VariationCheckpoint {
  const unsigned = {
    schema: 1 as const,
    runtimeVersion: input.runtimeVersion,
    policyVersion: input.policyVersion,
    evaluatorVersion: input.evaluatorVersion,
    state: structuredClone(input.state),
    signer: input.signer.id,
  };
  const hash = checkpointHash(unsigned);
  return { ...unsigned, checkpointHash: hash, signature: input.signer.sign(hash) };
}

export function verifyVariationCheckpoint(checkpoint: VariationCheckpoint, signer: ReceiptSigner): boolean {
  const { checkpointHash: _hash, signature: _signature, rvfManifestPath: _rvf, ...unsigned } = checkpoint;
  const expected = checkpointHash(unsigned);
  return expected === checkpoint.checkpointHash && signer.verify(expected, checkpoint.signature);
}

export class JsonCheckpointStore implements CheckpointStore {
  constructor(private readonly path: string) {}
  async save(checkpoint: VariationCheckpoint): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
    await rename(temp, this.path);
  }
  async load(): Promise<VariationCheckpoint | null> {
    try { return JSON.parse(await readFile(this.path, 'utf8')) as VariationCheckpoint; }
    catch { return null; }
  }
}
