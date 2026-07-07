// SPDX-License-Identifier: MIT
//
// TypeScript wrapper around the kernel's witness verification primitive.
//
// Per ADR-011, every harness ships with a `witness.json` next to its
// `.harness/manifest.json`. The publish gate verifies that signature
// BEFORE pushing the harness to npm or pinning it to IPFS — there is
// no path to publish an unsigned or tampered harness.
//
// The kernel's verify_manifest() does the real Ed25519 work; this TS
// layer only handles the JSON I/O and the publish-time check.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface WitnessEntry {
  id: string;
  desc: string;
  marker: string;
  sha256: string;
}

export interface WitnessManifest {
  schema: 1;
  harness: string;
  version: string;
  entries: WitnessEntry[];
  public_key: string;
  signature: string;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
  /**
   * GH #4 (HIGH-1): true when the manifest passed SHAPE checks but its signature was NOT
   * cryptographically verified (no kernel `witnessVerify` available — the shape-only degraded mode).
   * `valid` stays true so read-only diagnostics (`verify`/`doctor`) keep reporting shape validity, but a
   * caller that acts on the signature (publish) MUST treat `unverified` as "not actually signed".
   */
  unverified?: boolean;
}

/**
 * Verify a witness manifest by delegating to the kernel's wasm/native
 * verify_manifest(). Returns {valid: boolean, reason?: string}.
 *
 * The kernel is the security boundary — TS only does shape validation
 * before handing off.
 */
export async function verifyWitness(manifest: unknown): Promise<VerificationResult> {
  // Shape gate: never hand a malformed object to the kernel.
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, reason: 'manifest is not an object' };
  }
  const m = manifest as Partial<WitnessManifest>;
  if (m.schema !== 1) {
    return { valid: false, reason: `unsupported schema version ${m.schema}` };
  }
  if (!m.public_key || typeof m.public_key !== 'string' || m.public_key.length !== 64) {
    return { valid: false, reason: 'public_key must be 64-char hex string' };
  }
  if (!m.signature || typeof m.signature !== 'string' || m.signature.length !== 128) {
    return { valid: false, reason: 'signature must be 128-char hex string' };
  }
  if (!Array.isArray(m.entries)) {
    return { valid: false, reason: 'entries must be an array' };
  }
  if (!m.harness || typeof m.harness !== 'string') {
    return { valid: false, reason: 'harness must be a string' };
  }
  if (!m.version || typeof m.version !== 'string') {
    return { valid: false, reason: 'version must be a string' };
  }

  // Delegate to the kernel for the cryptographic check.
  try {
    const { loadKernel } = await import('@metaharness/kernel');
    const kernel = await loadKernel() as unknown as { witnessVerify?: (json: string) => boolean | string };
    if (typeof kernel.witnessVerify === 'function') {
      const result = kernel.witnessVerify(JSON.stringify(m));
      if (result === true) return { valid: true };
      if (result === false) return { valid: false, reason: 'kernel signature check failed' };
      return { valid: false, reason: String(result) };
    }
  } catch {
    // Kernel not available in this environment — fall through to
    // shape-only verification as a degraded mode (CI is the source of
    // truth; local-dev can skip the crypto verify).
  }

  return {
    valid: true,
    unverified: true,
    reason: 'shape verified; kernel witnessVerify unavailable — signature NOT cryptographically checked (degraded)',
  };
}

/**
 * Read and verify a witness.json file. Returns the parsed manifest on
 * success.
 */
export async function readAndVerify(witnessPath: string): Promise<{
  manifest: WitnessManifest;
  result: VerificationResult;
}> {
  if (!existsSync(witnessPath)) {
    throw new Error(`no witness at ${witnessPath}`);
  }
  const raw = await readFile(witnessPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`witness.json not valid JSON: ${err}`);
  }
  const result = await verifyWitness(parsed);
  return { manifest: parsed as WitnessManifest, result };
}

/**
 * Find a harness's witness.json. Convention: <harnessDir>/witness.json
 * or <harnessDir>/.harness/witness.json.
 */
export function findWitness(harnessDir: string): string | null {
  for (const cand of [
    join(harnessDir, 'witness.json'),
    join(harnessDir, '.harness', 'witness.json'),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}
