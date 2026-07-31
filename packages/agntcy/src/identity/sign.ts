// SPDX-License-Identifier: MIT
//
// ADR-237 S2.1: "The identity block is signed as part of the existing
// witness manifest (ADR-011 S'two manifests per release'), not a third
// independent signature scheme."
//
// ============================================================================
// INTEGRATION STATUS -- read before wiring this into a release pipeline
// ============================================================================
//
// This repo's REAL witness *signing* primitive is Rust, not TypeScript:
//
//   crates/kernel/src/witness.rs
//     pub fn sign_manifest(
//       signing_key: &SigningKey,
//       harness: &str,
//       version: &str,
//       entries: Vec<WitnessEntry>,
//     ) -> crate::Result<WitnessManifest>
//
// It is NOT currently exposed to TypeScript/JavaScript anywhere in this
// checkout. Verified by reading every wasm_bindgen/napi export surface:
//
//   - crates/kernel-wasm/src/lib.rs only exports `kernelInfo`,
//     `mcpValidate`, and `version` (see the #[wasm_bindgen] attributes in
//     that file) -- no witness sign OR verify binding exists yet.
//   - packages/kernel-js/src/index.ts (the `@metaharness/kernel` package
//     that `loadKernel()` resolves) exports no witness function either.
//   - packages/create-agent-harness/src/witness-client.ts::verifyWitness()
//     is the one place in this repo that calls into a kernel witness
//     primitive today:
//       const { loadKernel } = await import('@metaharness/kernel');
//       const kernel = await loadKernel();
//       if (typeof kernel.witnessVerify === 'function') { ... }
//     -- but that is VERIFY, not SIGN, and even that call degrades to
//     shape-only "unverified" verification today (see the fallback branch
//     at witness-client.ts's catch block) because no `witnessVerify`
//     binding exists in crates/kernel-wasm/src/lib.rs either.
//
// TODO(agntcy-identity-signing): once a `witnessSign` binding is added to
// crates/kernel-wasm/src/lib.rs -- mirroring `mcp_validate`'s
// `#[wasm_bindgen(js_name = ...)]` pattern, and wrapping
// crates/kernel/src/witness.rs::sign_manifest -- and exposed on the object
// `loadKernel()` resolves, wire it in here as the production
// `WitnessSigningFn`, following the exact call convention
// witness-client.ts::verifyWitness() already establishes for the verify
// half:
//
//   const { loadKernel } = await import('@metaharness/kernel');
//   const kernel = await loadKernel();
//   const witnessSign: WitnessSigningFn = (entries) =>
//     kernel.witnessSign(harness, version, entries);
//
// Until that binding exists, `signIdentityBlock` below does the REAL,
// non-stubbed part of this task: it deterministically folds the identity
// block into the witness manifest's `entries` array as one more attested
// WitnessEntry, so whatever signing function the caller injects signs
// identity + everything else together, in one signature -- per ADR-237
// S2.1's explicit "not a third independent signature scheme" requirement.
// What it deliberately does NOT do is generate its own Ed25519 keypair or
// perform any cryptographic signing itself -- that stays the kernel's job,
// per witness-client.ts's own "the kernel is the security boundary" note.
// ============================================================================

import { createHash } from 'node:crypto';
import type { AgntcyIdentity } from './schema.js';
import { validateAgntcyIdentity } from './schema.js';

/**
 * Mirrors packages/create-agent-harness/src/witness-client.ts's
 * `WitnessEntry` interface exactly. Duplicated here rather than imported:
 * packages/agntcy is a dependency-free optional peer package (per this
 * package's own package.json description and ADR-002's kernel-boundary
 * discipline) and must not acquire a hard filesystem/workspace coupling to
 * @metaharness/create-agent-harness.
 */
export interface WitnessEntry {
  id: string;
  desc: string;
  marker: string;
  sha256: string;
}

/**
 * Mirrors witness-client.ts's `WitnessManifest` shape exactly. This is the
 * type `existingWitnessSigningFn` is expected to produce -- the "signed
 * result type" the identity block gets folded into.
 */
export interface WitnessManifest {
  schema: 1;
  harness: string;
  version: string;
  entries: WitnessEntry[];
  public_key: string;
  signature: string;
}

/**
 * The shape of the real signing entry point this file composes into.
 * Modeled directly on crates/kernel/src/witness.rs::sign_manifest's
 * signature (harness, version, entries -> signed manifest); here the
 * caller is expected to have already bound `harness`/`version` (they own
 * the release context), so the injected function only needs the final
 * entries list -- the one thing `signIdentityBlock` actually changes. See
 * the TODO block above for exactly which real function this should
 * ultimately delegate to.
 */
export type WitnessSigningFn = (
  entries: WitnessEntry[],
) => WitnessManifest | Promise<WitnessManifest>;

const IDENTITY_ENTRY_ID = 'agntcy-identity';

/**
 * Canonicalize an AgntcyIdentity into the deterministic byte form that gets
 * hashed for its witness entry. Uses a fixed key order (not a general
 * alphabetical sort) to mirror
 * crates/kernel/src/witness.rs::canonical_payload's approach of relying on
 * a fixed struct-field order for cross-run determinism, rather than
 * pulling in a general-purpose canonical-JSON library this repo doesn't
 * depend on. `badges` IS sorted (it is caller-supplied and unordered by
 * nature), so two identity blocks with the same badge set in a different
 * array order hash identically.
 */
export function canonicalizeIdentity(identity: AgntcyIdentity): string {
  const badges = [...identity.badges].sort();
  return JSON.stringify({
    subject: identity.subject,
    issuer: identity.issuer,
    badges,
    tenant: identity.tenant,
  });
}

/**
 * Project an AgntcyIdentity into the WitnessEntry that represents it inside
 * the witness manifest's `entries` array -- the mechanism ADR-237 S2.1
 * specifies for signing identity as part of the existing manifest instead
 * of standing up a parallel signature.
 */
export function identityToWitnessEntry(identity: AgntcyIdentity): WitnessEntry {
  const canonical = canonicalizeIdentity(identity);
  return {
    id: IDENTITY_ENTRY_ID,
    desc: `AGNTCY identity: subject=${identity.subject} tenant=${identity.tenant}`,
    marker: identity.subject,
    sha256: createHash('sha256').update(canonical, 'utf-8').digest('hex'),
  };
}

/**
 * Compose an AgntcyIdentity into a witness-manifest signing call, per
 * ADR-237 S2.1: identity is signed AS PART OF the existing witness
 * manifest, never by a second, independent signature scheme.
 *
 * This function does not sign anything itself. It shape-gates `identity`
 * (mirroring witness-client.ts's "never hand a malformed object to the
 * kernel" discipline), builds the WitnessEntry the identity projects to,
 * appends it to any entries the caller already has for this release, and
 * hands the combined list to `existingWitnessSigningFn` -- see the TODO
 * block at the top of this file for exactly which real function that
 * parameter should resolve to once a JS/wasm binding for
 * crates/kernel/src/witness.rs::sign_manifest exists.
 *
 * @throws if `identity` fails schema.ts's `validateAgntcyIdentity()` shape
 *   gate.
 */
export async function signIdentityBlock(
  identity: { subject: string; issuer: string; badges: string[]; tenant: string },
  existingWitnessSigningFn: WitnessSigningFn,
  priorEntries: WitnessEntry[] = [],
): Promise<WitnessManifest> {
  const check = validateAgntcyIdentity(identity);
  if (!check.valid) {
    throw new Error(`signIdentityBlock: invalid identity block -- ${check.reason}`);
  }

  const entries = [...priorEntries, identityToWitnessEntry(identity as AgntcyIdentity)];
  return existingWitnessSigningFn(entries);
}
