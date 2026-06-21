// SPDX-License-Identifier: MIT
//
// Darwin Shield — the safety layer (ADR-155 §safety controls). The load-bearing
// security boundary. Darwin Shield is STRICTLY DEFENSIVE: it discovers and
// remediates weaknesses in owned/authorized code and emits patches, tests,
// advisories, and risk reports — never working exploits.
//
// Four independent, defense-in-depth gates, all CODE not comments:
//
//   assertScope()        — a scan may only run against an owned/authorized repo.
//   redactUnsafeOutput() — strips/flags weaponized content from any string that
//                          would leave the sandbox (evidence, patch, advisory).
//   gateFinding()        — a Finding is admissible only if it carries no exploit
//                          payload and `exploitCodeAllowed` is false.
//   gateOutputs()        — batch gate over a run's findings; returns the safe set
//                          plus the count of rejected unsafe outputs (MUST be 0
//                          for a run to pass acceptance, ADR-155).
//
// This mirrors the kernel safety gate (`../safety.ts`, ADR-071) but operates on
// OUTPUT content (what we emit) rather than mutation-surface source (what we run).

import type { Finding, ScopeAssertion } from './types.js';

/**
 * Content patterns that mark a string as a weaponized/offensive payload. If any
 * matches, the output is unsafe: it is redacted before emission and the run's
 * unsafe-output counter increments (a −1.00 fitness term — immediate rejection).
 *
 * Intentionally broad. A defensive finding describes WHERE a weakness is and HOW
 * to fix it; it never ships a runnable exploit, reverse shell, dropper, or
 * persistence/evasion mechanism.
 */
export const UNSAFE_OUTPUT_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /reverse\s*shell|bind\s*shell|\bmeterpreter\b|\bmsfvenom\b/i, reason: 'remote shell payload' },
  { re: /\bnc\s+-[a-z]*e\b|bash\s+-i\s*>?\s*&?\s*\/dev\/tcp/i, reason: 'netcat/bash reverse shell' },
  { re: /\/dev\/tcp\/\d|\bsocket\.\w+\(.*connect/i, reason: 'raw socket exploit connect-back' },
  { re: /\bexploit\s*(chain|payload|kit)\b|\bweaponi[sz]e/i, reason: 'weaponized exploit chain' },
  { re: /\bdropper\b|\bpersistence\s*(mechanism|implant)\b|\bcrontab\s+-|\bLaunchAgents\b/i, reason: 'persistence mechanism' },
  { re: /\brootkit\b|\bkeylogger\b|\bransomware\b|\bbotnet\b|\bc2\s*server\b/i, reason: 'malware component' },
  { re: /\bAV\s*evasion\b|\bAMSI\s*bypass\b|\bobfuscat(e|ed)\s+payload\b|\bdefender\s*bypass\b/i, reason: 'detection evasion' },
  { re: /\bdump\s+(credential|password|hashes)\b|\bmimikatz\b|\bsekurlsa\b/i, reason: 'credential theft tooling' },
  { re: /BEGIN [A-Z ]*PRIVATE KEY/i, reason: 'embedded private key' },
  { re: /\bshellcode\b|\\x[0-9a-f]{2}(\\x[0-9a-f]{2}){8,}/i, reason: 'shellcode blob' },
];

/** A scope assertion is valid iff the repo is explicitly owned or authorized. */
export function assertScope(scope: ScopeAssertion): { ok: boolean; reason: string } {
  if (!scope.repo || scope.repo.trim() === '') {
    return { ok: false, reason: 'no repository specified' };
  }
  if (scope.scope === 'owned') {
    return { ok: true, reason: 'owned repository' };
  }
  if (scope.scope === 'authorized') {
    if (!scope.authorization || scope.authorization.trim() === '') {
      return { ok: false, reason: 'authorized scope requires an authorization attestation' };
    }
    return { ok: true, reason: `authorized: ${scope.authorization}` };
  }
  return { ok: false, reason: `unknown scope "${(scope as { scope: string }).scope}"` };
}

/** Throwing form of {@link assertScope} for guard-clause call sites. */
export function requireScope(scope: ScopeAssertion): void {
  const r = assertScope(scope);
  if (!r.ok) throw new Error(`scope gate: ${r.reason}`);
}

/** Find every unsafe pattern present in a string (deduplicated reasons). */
export function detectUnsafe(text: string): string[] {
  const reasons: string[] = [];
  for (const { re, reason } of UNSAFE_OUTPUT_PATTERNS) {
    if (re.test(text)) reasons.push(reason);
  }
  return [...new Set(reasons)];
}

/** True iff a string carries no weaponized content. */
export function isSafeOutput(text: string): boolean {
  return detectUnsafe(text).length === 0;
}

/**
 * Redact a string for emission. Returns the sanitized text plus the reasons it
 * was flagged (empty ⇒ already safe). Matched spans are replaced with a marker
 * so the advisory remains readable without shipping the payload.
 */
export function redactUnsafeOutput(text: string): { safe: string; reasons: string[] } {
  let safe = text;
  const reasons: string[] = [];
  for (const { re, reason } of UNSAFE_OUTPUT_PATTERNS) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const global = new RegExp(re.source, flags);
    if (global.test(safe)) {
      reasons.push(reason);
      safe = safe.replace(global, '[REDACTED:unsafe-content]');
    }
  }
  return { safe, reasons: [...new Set(reasons)] };
}

/** The verdict of gating a single finding. */
export interface FindingGate {
  /** The (possibly redacted) finding, or null if it must be dropped entirely. */
  finding: Finding | null;
  unsafe: boolean;
  reasons: string[];
}

/**
 * Gate a single finding. Strategy: redact evidence/patch/advisory text in place;
 * if anything had to be redacted the finding is marked unsafe (counts toward the
 * −1.00 fitness term) but the SANITIZED finding is still returned so the run can
 * report "we found a weakness here" without ever emitting the payload. A finding
 * that (impossibly) carries `exploitCodeAllowed !== false` is dropped outright.
 */
export function gateFinding(finding: Finding): FindingGate {
  // Structural invariant: the platform never authorizes exploit code.
  if ((finding as { exploitCodeAllowed: unknown }).exploitCodeAllowed !== false) {
    return { finding: null, unsafe: true, reasons: ['exploitCodeAllowed must be false'] };
  }

  const reasons: string[] = [];
  const evidence = finding.evidence.map((e) => {
    const r = redactUnsafeOutput(e);
    reasons.push(...r.reasons);
    return r.safe;
  });
  let patch = finding.patch;
  if (patch !== undefined) {
    const r = redactUnsafeOutput(patch);
    reasons.push(...r.reasons);
    patch = r.safe;
  }
  let test = finding.test;
  if (test !== undefined) {
    const r = redactUnsafeOutput(test);
    reasons.push(...r.reasons);
    test = r.safe;
  }
  const uniqueReasons = [...new Set(reasons)];
  const safeFinding: Finding = {
    ...finding,
    evidence,
    ...(patch !== undefined ? { patch } : {}),
    ...(test !== undefined ? { test } : {}),
  };
  return { finding: safeFinding, unsafe: uniqueReasons.length > 0, reasons: uniqueReasons };
}

/** The verdict of gating a whole run's outputs. */
export interface OutputGate {
  /** The sanitized, admissible findings. */
  safe: Finding[];
  /** Number of findings that contained unsafe content (the acceptance counter). */
  unsafeOutputs: number;
  /** Every unsafe reason observed, for the audit receipt. */
  reasons: string[];
}

/**
 * Batch gate over a run's findings (the "safety-redactor" agent). For ADR-155
 * acceptance, a run passes only when `unsafeOutputs === 0`. Because Darwin Shield
 * never generates exploit code, that count is structurally 0 in normal operation;
 * this gate is the proof, and the catch for any regression.
 */
export function gateOutputs(findings: Finding[]): OutputGate {
  const safe: Finding[] = [];
  const reasons: string[] = [];
  let unsafeOutputs = 0;
  for (const f of findings) {
    const g = gateFinding(f);
    if (g.unsafe) {
      unsafeOutputs += 1;
      reasons.push(...g.reasons);
    }
    if (g.finding) safe.push(g.finding);
  }
  return { safe, unsafeOutputs, reasons: [...new Set(reasons)] };
}
