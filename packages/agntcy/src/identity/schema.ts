// SPDX-License-Identifier: MIT
//
// ADR-237 S2.1 -- the AGNTCY identity block added to `.harness/manifest.json`
// (and its HarnessSpec / ADR-159 serialization), alongside -- never
// replacing -- the existing ADR-011 witness manifest. Worked example from
// the ADR:
//
//   {
//     "identity": {
//       "subject": "did:agntcy:cognitum:researcher",
//       "issuer": "cognitum.one",
//       "badges": ["code.read", "tests.execute"],
//       "tenant": "customer_117"
//     }
//   }
//
// No Zod here: grepped this repo's `packages/*/src` for `from 'zod'` --
// zero hits, so this repo does not already use Zod. The repo's existing
// convention for boundary/shape validation is a hand-rolled shape gate (see
// packages/create-agent-harness/src/witness-client.ts::verifyWitness --
// "Shape gate: never hand a malformed object to the kernel"), so this file
// follows that established pattern instead of introducing a new dependency.
// It also keeps faith with this package's own package.json description:
// "Dependency-free (Node built-ins)".

/**
 * DID method this ADR mints/expects. ADR-237 S2.1: "subject is a W3C DID
 * minted per-harness (or per-tenant-deployment) through AGNTCY's
 * identity-provider integration."
 */
export const AGNTCY_DID_PREFIX = 'did:agntcy:';

/**
 * The AGNTCY identity block, exactly as specified in ADR-237 S2.1.
 */
export interface AgntcyIdentity {
  /** W3C DID, e.g. "did:agntcy:cognitum:researcher". */
  subject: string;
  /** The credential issuer, e.g. "cognitum.one". */
  issuer: string;
  /**
   * Task-specific verifiable-credential badges. See from-mcp-scan.ts for
   * the real (non-invented) derivation from the harness's own tool-policy
   * allowlist, per ADR-237 S2.1: "every allowed tool scope becomes a
   * candidate badge, not an arbitrary string a generator invents."
   */
  badges: string[];
  /**
   * Existing Cognitum tenant id. ADR-237 S2.1: "tenant maps onto existing
   * Cognitum tenancy rather than introducing a second tenant model."
   */
  tenant: string;
}

export interface AgntcyIdentityValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Shape-gate a value against AgntcyIdentity, mirroring
 * witness-client.ts's verifyWitness() shape-gate style: never hand a
 * malformed object further down the pipeline (e.g. into sign.ts, which
 * folds the identity into the signed witness manifest).
 */
export function validateAgntcyIdentity(value: unknown): AgntcyIdentityValidationResult {
  if (!value || typeof value !== 'object') {
    return { valid: false, reason: 'identity is not an object' };
  }
  const v = value as Partial<Record<keyof AgntcyIdentity, unknown>>;

  if (typeof v.subject !== 'string' || v.subject.length === 0) {
    return { valid: false, reason: 'subject must be a non-empty string' };
  }
  if (!v.subject.startsWith(AGNTCY_DID_PREFIX)) {
    return {
      valid: false,
      reason: `subject must start with "${AGNTCY_DID_PREFIX}" (got "${v.subject}")`,
    };
  }
  if (typeof v.issuer !== 'string' || v.issuer.length === 0) {
    return { valid: false, reason: 'issuer must be a non-empty string' };
  }
  if (!Array.isArray(v.badges) || !v.badges.every((b) => typeof b === 'string')) {
    return { valid: false, reason: 'badges must be a string[]' };
  }
  if (typeof v.tenant !== 'string' || v.tenant.length === 0) {
    return { valid: false, reason: 'tenant must be a non-empty string' };
  }

  return { valid: true };
}

/** Type predicate wrapper around validateAgntcyIdentity(). */
export function isAgntcyIdentity(value: unknown): value is AgntcyIdentity {
  return validateAgntcyIdentity(value).valid;
}
