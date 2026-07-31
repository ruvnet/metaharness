// SPDX-License-Identifier: MIT
//
// CASA authority envelope schema (ADR-240 §4 / companion ruflo ADR-380 §3).
//
// The envelope is the bounded, serializable authorization contract CASA
// (Continuous Agentic Semantic Authorization) enforces at runtime. Its shape
// is fixed by the two ADRs and MUST NOT be extended without updating both
// documents AND the mirrored TypeScript schema in `ruflo`'s
// `plugins/ruflo-agntcy/src/casa/schema.ts` — the two repos' envelopes must
// stay interoperable field-for-field:
//
//   {
//     "objective": "review repository security",
//     "allow": ["repository.read", "tests.execute"],
//     "deny": ["git.push", "secret.export", "deployment.create"],
//     "budget_usd": 8,
//     "expires_at": "2026-07-30T22:00:00Z"
//   }
//
// ============================================================================
// LOAD-BEARING INVARIANT (ADR-240 §4 / ADR-380 §3) — restated here because
// every module in this package touches it:
//
//   Translating free-text intent INTO this envelope MAY, in a future
//   iteration, use an LLM (see compile.ts's `translator` extension point).
//
//   ENFORCING this envelope — checking a requested action against
//   allow/deny/expires_at — MUST NEVER call an LLM or any nondeterministic
//   judgment. Enforcement is a pure, deterministic function over this
//   bounded schema, deny-by-default (anything not explicitly in `allow` is
//   denied).
//
//   This package (`@metaharness/agntcy`, `packages/agntcy/src/casa/`) is
//   COMPILE-TIME ONLY. It never enforces an envelope against a live
//   invocation — it only ever produces or validates envelope *data*.
//   Enforcement lives in the companion `ruflo` repo, per ADR-240 §3/§4
//   (`plugins/ruflo-agntcy/src/casa/enforce.ts` on that side).
// ============================================================================
//
// This module performs no authorization logic whatsoever — it only checks
// that a candidate value has the right shape. Dependency-free by design
// (matches this repo's `@metaharness/redblue` / `@metaharness/flywheel`
// convention of relying on Node built-ins only rather than pulling in a
// schema-validation library the rest of this repo does not already use).

/**
 * A resource-scope string, e.g. `repository.read`, `git.push`,
 * `secret.export`. Deliberately just `string` (not an enum) — the set of
 * scopes is open-ended and governed by whatever CASA-compatible network the
 * envelope targets, not by this repo. Must be non-empty.
 */
export type CasaScope = string;

/**
 * The CASA authority envelope. Field names and types are fixed by ADR-240
 * §4 and mirrored exactly (no divergence) in ruflo's
 * `plugins/ruflo-agntcy/src/casa/schema.ts` so envelopes compiled here can
 * be consumed there without translation.
 */
export interface CasaEnvelope {
  /** Free-text objective the envelope was compiled from. */
  objective: string;
  /**
   * Explicitly permitted action scopes. Deny-by-default: anything not
   * listed here is denied, even if it is also absent from `deny`.
   */
  allow: CasaScope[];
  /** Explicitly forbidden action scopes. Deny always wins over allow. */
  deny: CasaScope[];
  /** Maximum USD spend authorized under this envelope. Must be positive. */
  budget_usd: number;
  /** Envelope expiry, ISO 8601 timestamp string. */
  expires_at: string;
}

/** The exact set of top-level keys a valid {@link CasaEnvelope} may have. */
const CASA_ENVELOPE_KEYS = ['objective', 'allow', 'deny', 'budget_usd', 'expires_at'] as const;

/**
 * Thrown by {@link parseCasaEnvelope} when a candidate value does not match
 * the {@link CasaEnvelope} shape. Carries every violation found (not just
 * the first) so callers get a complete picture in one pass, mirroring how
 * ruflo's Zod-based schema reports a `ZodError` with a full `issues` array.
 */
export class CasaEnvelopeValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid CasaEnvelope: ${issues.join('; ')}`);
    this.name = 'CasaEnvelopeValidationError';
    this.issues = issues;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function collectScopeIssues(fieldName: 'allow' | 'deny', value: unknown, issues: string[]): void {
  if (!isStringArray(value)) {
    issues.push(`${fieldName} must be an array of strings`);
    return;
  }
  value.forEach((scope, index) => {
    if (scope.length === 0) {
      issues.push(`${fieldName}[${index}] must be a non-empty string`);
    }
  });
}

/**
 * Validate a candidate value against the {@link CasaEnvelope} shape and
 * return every issue found (empty array = valid). Pure, synchronous,
 * deterministic — no I/O, no network, no LLM. This function only checks
 * shape; it never decides whether an action is authorized (that is
 * `enforce.ts`'s job, and it lives in `ruflo`, not here).
 */
export function validateCasaEnvelope(candidate: unknown): string[] {
  const issues: string[] = [];

  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return ['envelope must be a non-null object'];
  }

  const record = candidate as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(CASA_ENVELOPE_KEYS as readonly string[]).includes(key)) {
      issues.push(`unexpected key "${key}" (envelope schema is strict)`);
    }
  }

  if (!isNonEmptyString(record.objective)) {
    issues.push('objective must be a non-empty string');
  }

  collectScopeIssues('allow', record.allow, issues);
  collectScopeIssues('deny', record.deny, issues);

  if (typeof record.budget_usd !== 'number' || !Number.isFinite(record.budget_usd) || record.budget_usd <= 0) {
    issues.push('budget_usd must be a positive finite number');
  }

  if (!isNonEmptyString(record.expires_at) || Number.isNaN(Date.parse(record.expires_at))) {
    issues.push('expires_at must be a valid ISO 8601 timestamp string');
  }

  return issues;
}

/**
 * Parse and validate a candidate value, returning a narrowed
 * {@link CasaEnvelope} or throwing {@link CasaEnvelopeValidationError}.
 * Structural validation only — see the module doc comment above for the
 * enforcement-vs-compilation boundary this function stays on the right
 * side of.
 */
export function parseCasaEnvelope(candidate: unknown): CasaEnvelope {
  const issues = validateCasaEnvelope(candidate);
  if (issues.length > 0) {
    throw new CasaEnvelopeValidationError(issues);
  }
  return candidate as CasaEnvelope;
}

/** Type guard built on {@link validateCasaEnvelope}. */
export function isCasaEnvelope(candidate: unknown): candidate is CasaEnvelope {
  return validateCasaEnvelope(candidate).length === 0;
}
