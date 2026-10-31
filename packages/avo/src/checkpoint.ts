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
  // `checkpointHash`/`canonical` (crypto.ts) now throw on a value that cannot be safely canonicalized
  // (over-depth or non-finite) rather than silently colliding — such a checkpoint cannot be confirmed
  // authentic, so it must fail this check the same as any other mismatch. `operator.ts`'s
  // `restoreOrInitialize` calls this as `if (!verifyVariationCheckpoint(...)) throw ...` for its own
  // clean, documented error message; letting a canonicalization error escape here instead would bypass
  // that message with a less diagnostic one from one level down.
  try {
    const { checkpointHash: _hash, signature: _signature, rvfManifestPath: _rvf, ...unsigned } = checkpoint;
    const expected = checkpointHash(unsigned);
    return expected === checkpoint.checkpointHash && signer.verify(expected, checkpoint.signature);
  } catch {
    return false;
  }
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
