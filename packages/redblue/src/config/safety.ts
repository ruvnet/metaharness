// SPDX-License-Identifier: MIT
//
// SAFETY BOUNDARY — enforced in code, not just docs.
//
// This module is the single chokepoint that makes the harness shippable and
// legitimate. Red actors are uncontrolled in BEHAVIOR, not CAPABILITY. The
// functions here:
//   1. Reject configs that try to unlock dangerous capabilities.
//   2. Redact sensitive strings before they are stored or emitted.
//   3. Provide the credential/network/shell guards the runner consults.
//
// Nothing in the red-team path can bypass these — the config loader calls
// enforceSafetyLimits() and refuses to return a config that fails it, and the
// runner calls assertNoLiveCredential()/redact() on every boundary crossing.

import type { Limits, TargetConfig } from '../types.js';

/** Raised when a config or runtime action violates the hard safety boundary. */
export class SafetyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafetyViolationError';
  }
}

/**
 * The non-negotiable defaults. A loaded config may NOT relax these to `true`.
 * They are forced off regardless of what the YAML says, and an explicit
 * attempt to enable them is a hard error (so the operator is never silently
 * surprised, and a malicious config can't quietly open a hole).
 */
export const HARD_SAFE_DEFAULTS = {
  allow_network: false,
  allow_shell: false,
  allow_real_credentials: false,
} as const;

/**
 * Validate + clamp the limits block. Throws on any attempt to enable a
 * dangerous capability; clamps numeric budgets to sane bounds.
 */
export function enforceSafetyLimits(limits: Limits): Limits {
  if (limits.allow_network === true) {
    throw new SafetyViolationError(
      'allow_network:true is forbidden — the harness drives only the configured target, never arbitrary network.',
    );
  }
  if (limits.allow_shell === true) {
    throw new SafetyViolationError(
      'allow_shell:true is forbidden — no shell execution is ever permitted.',
    );
  }
  if (limits.allow_real_credentials === true) {
    throw new SafetyViolationError(
      'allow_real_credentials:true is forbidden — never supply real secrets to an adversarial run.',
    );
  }
  if (!Number.isFinite(limits.max_tests) || limits.max_tests <= 0) {
    throw new SafetyViolationError('limits.max_tests must be a positive number.');
  }
  if (!Number.isFinite(limits.max_cost_usd) || limits.max_cost_usd < 0) {
    throw new SafetyViolationError('limits.max_cost_usd must be >= 0.');
  }
  if (!Number.isFinite(limits.max_runtime_minutes) || limits.max_runtime_minutes <= 0) {
    throw new SafetyViolationError('limits.max_runtime_minutes must be positive.');
  }
  // Force the dangerous flags off no matter what.
  return {
    max_tests: Math.floor(limits.max_tests),
    max_cost_usd: limits.max_cost_usd,
    max_runtime_minutes: limits.max_runtime_minutes,
    ...HARD_SAFE_DEFAULTS,
  };
}

/**
 * Validate the target. Only loopback / explicitly-marked test hosts are
 * allowed when network is off (which it always is). A "none" target is the
 * pure in-proc mock path.
 */
export function validateTarget(target: TargetConfig): void {
  if (target.kind === 'none') return;
  if (target.kind !== 'http') {
    throw new SafetyViolationError(`Unsupported target.kind: ${String(target.kind)}`);
  }
  if (!target.url) {
    throw new SafetyViolationError('http target requires a url.');
  }
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    throw new SafetyViolationError(`target.url is not a valid URL: ${target.url}`);
  }
  // Network is hard-off, so a target MUST be a local loopback / test endpoint.
  // This prevents pointing the red team at a live external production target.
  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test') ||
    host.endsWith('.internal');
  if (!isLoopback) {
    throw new SafetyViolationError(
      `target.url host "${host}" is not a loopback/test host. ` +
        'Live external targets are forbidden — stand up a local copy of the system you own.',
    );
  }
}

/** Patterns that look like real credentials. We refuse to forward these. */
const CREDENTIAL_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'openai_key', re: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { label: 'openrouter_key', re: /\bsk-or-[A-Za-z0-9-]{16,}\b/ },
  { label: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/ },
  { label: 'private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/** Generic sensitive content (PII-ish) we redact from stored evidence. */
const SENSITIVE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  ...CREDENTIAL_PATTERNS,
  { label: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { label: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: 'credit_card', re: /\b(?:\d[ -]?){13,16}\b/g },
];

/**
 * Refuse to forward any payload that contains a real-credential-shaped token.
 * The harness must never inject real secrets into an adversarial run.
 */
export function assertNoLiveCredential(payload: string): void {
  for (const { label, re } of CREDENTIAL_PATTERNS) {
    if (re.test(payload)) {
      throw new SafetyViolationError(
        `Refusing to forward a payload containing a real-credential-shaped token (${label}). ` +
          'Adversarial runs must use only synthetic/placeholder secrets.',
      );
    }
  }
}

/**
 * Redact sensitive substrings for safe storage/reporting. Used on every
 * piece of evidence and every saved transcript when redact_sensitive_outputs
 * is on (the default).
 */
export function redact(text: string): string {
  let out = text;
  for (const { label, re } of SENSITIVE_PATTERNS) {
    out = out.replace(re, `[REDACTED:${label}]`);
  }
  return out;
}

/** Convenience: redact an array of evidence strings. */
export function redactAll(items: string[]): string[] {
  return items.map(redact);
}
