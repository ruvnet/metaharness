// SPDX-License-Identifier: MIT
//
// Single source of truth for secret redaction in every user-facing output surface — the diag
// support-bundle, export-config, score/genome/threat-model sanitisers (GH #4 finding #7). Before this,
// five copies of the same recursive redactor each keyed ONLY on object-key NAMES, so a secret-shaped
// VALUE landing in a field NOT named secret/token/key (e.g. a token pasted into a `vars` entry) sailed
// through into a `harness diag --bundle` a user pastes into a GitHub issue — the exact HIGH-2 leak in #4
// (the "bundle is sanitised" promise was value-blind). This module adds VALUE-aware detection on top of
// the key-name pass, so both a secret-named key AND a secret-shaped value redact.

// High-confidence provider token shapes (prefix-anchored — near-zero false positives).
const SECRET_PREFIX_RE =
  /(?:^|[^A-Za-z0-9])(sk-[A-Za-z0-9]|sk-ant-|rk_[A-Za-z0-9]|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xox[baprs]-|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{10,}|ya29\.|npm_[A-Za-z0-9]{20}|AC[a-z0-9]{30,}|SK[a-z0-9]{30,})/;
// PEM private-key blocks.
const PEM_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/;
// JWT (header.payload.signature, all base64url).
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

/**
 * Heuristic: does this STRING look like a secret, independent of the key it's stored under?
 *
 * Conservative by construction — precision is favoured over recall because over-redacting a legitimate
 * value in a score/genome dump is a real (if smaller) cost:
 *   1. a known provider token prefix (sk-/ghp_/AKIA/AIza/JWT/PEM/…) — high confidence, OR
 *   2. a generic ≥40-char base64/token run that is MIXED-CASE alphanumeric (letters+digits, upper+lower).
 *
 * The mixed-case+digit requirement in (2) deliberately EXCLUDES lowercase-hex git SHAs, uppercase-hex
 * digests, and dashed UUIDs — all common NON-secret identifiers — so we don't redact them.
 */
export function looksLikeSecretValue(s: unknown): boolean {
  if (typeof s !== 'string' || s.length < 20) return false;
  if (PEM_RE.test(s) || JWT_RE.test(s) || SECRET_PREFIX_RE.test(s)) return true;
  const m = s.match(/[A-Za-z0-9_\-+/=]{40,}/);
  if (m) {
    const tok = m[0];
    if (/[A-Z]/.test(tok) && /[a-z]/.test(tok) && /[0-9]/.test(tok)) return true;
  }
  return false;
}

export interface RedactOptions {
  /** Redact a value when its KEY name matches (the existing behaviour of every call site). */
  keyRe: RegExp;
  /** The replacement token — kept per-site (`<redacted>` for bundles, `[REDACTED]` for score/genome/threat). */
  replacement: string;
}

/**
 * Deep-copy `value`, redacting (a) any object value whose KEY matches `keyRe`, and (b) any string
 * value that `looksLikeSecretValue` — anywhere in the tree, including a bare top-level string.
 * Non-string primitives pass through. Pure (no I/O); safe to run on untrusted manifest/config data.
 */
export function redactSecretsDeep(value: unknown, opts: RedactOptions): unknown {
  const { keyRe, replacement } = opts;
  if (value == null) return value;
  if (typeof value === 'string') return looksLikeSecretValue(value) ? replacement : value;
  if (Array.isArray(value)) return value.map(v => redactSecretsDeep(v, opts));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = keyRe.test(k) ? replacement : redactSecretsDeep(v, opts);
    }
    return out;
  }
  return value;
}
