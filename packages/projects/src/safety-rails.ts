// SPDX-License-Identifier: MIT
//
// @metaharness/projects — safety-rails.ts (ADR-164 Darwin Safety Rails).
//
// The anti-reward-hacking spine, borrowed from NeMo Guardrails: a battery of
// IMMUTABLE, programmable rails evaluated BEFORE benchmark execution. Darwin Mode
// mutates the POLICY OBJECT — it does NOT mutate these rails. A candidate change
// that disables tests, weakens security, edits secrets handling, bypasses the
// sandbox, or touches a protected file (scoring/policy/.github/safetyProfile) is
// rejected pre-eval, so a mutation can never "win" by cheating the benchmark.
//
// Rails are Object.freeze'd and the registry is frozen, demonstrating that the
// rails are NOT in the mutation surface: any attempt to alter a rail throws in
// strict mode (and tests assert it).
//
// The optimization (measured in bench/safety-rails.bench.mjs): a battery of
// adversarial mutations is screened in O(rails × change) before any expensive
// benchmark run. The bench reports cheat-rejection coverage (target 100%) and
// false rejections of clean changes (target 0).

// ─────────────────────────────────────────────────────────────────────────────
// Candidate + violation types.
// ─────────────────────────────────────────────────────────────────────────────

/** A proposed mutation/diff to be screened before benchmarking. */
export interface CandidateChange {
  id: string;
  diff: string;
  touchedFiles: string[];
  disablesTests: boolean;
  weakensSecurity: boolean;
  editsSecretsHandling: boolean;
  bypassesSandbox: boolean;
  protectedFilesTouched: string[];
}

/** A tripped rail: which rail and why. */
export interface RailViolation {
  railId: string;
  message: string;
}

/** An immutable safety rail. `check` returns a violation or null. */
export interface SafetyRail {
  readonly id: string;
  readonly description: string;
  readonly immutable: true;
  check(c: CandidateChange): RailViolation | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Protected-path policy. A path is protected if it touches scoring, policy, the
// CI definitions, or the safety profile — i.e. anything that could let a mutation
// grade its own homework. Centralized so both the rail and tests agree.
// ─────────────────────────────────────────────────────────────────────────────

// Word-boundary names of protected components (the scorer, the policy, the
// safety profile). Matched on whole tokens so `scoring-helpers.ts` IS protected
// (scorer-adjacent) but `policyholder.ts` is NOT a false positive.
const PROTECTED_WORDS = ['scoring', 'policy', 'safetyprofile'];

/** True if a file path falls under the protected set (normalized, word-anchored). */
export function isProtectedPath(path: string): boolean {
  const norm = String(path ?? '').replace(/\\/g, '/').toLowerCase();
  if (norm.includes('.github/')) return true; // CI config is protected wholesale
  return PROTECTED_WORDS.some((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(norm));
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in rails. Each is a deep-frozen object so neither its id nor its check
// can be swapped out — the rails themselves are outside the mutation surface.
// ─────────────────────────────────────────────────────────────────────────────

/** Construct one frozen rail. */
function makeRail(
  id: string,
  description: string,
  check: (c: CandidateChange) => RailViolation | null,
): SafetyRail {
  return Object.freeze({ id, description, immutable: true as const, check });
}

/** The immutable battery of built-in rails (each frozen). */
export function builtinRails(): readonly SafetyRail[] {
  const rails: SafetyRail[] = [
    makeRail('no-disable-tests', 'rejects mutations that disable or skip tests', (c) =>
      c.disablesTests ? { railId: 'no-disable-tests', message: 'mutation disables tests' } : null,
    ),
    makeRail('no-weaken-security', 'rejects mutations that weaken security controls', (c) =>
      c.weakensSecurity ? { railId: 'no-weaken-security', message: 'mutation weakens security' } : null,
    ),
    makeRail('no-secrets-handling-change', 'rejects edits to secrets handling', (c) =>
      c.editsSecretsHandling
        ? { railId: 'no-secrets-handling-change', message: 'mutation edits secrets handling' }
        : null,
    ),
    makeRail('no-bypass-sandbox', 'rejects mutations that bypass the sandbox', (c) =>
      c.bypassesSandbox ? { railId: 'no-bypass-sandbox', message: 'mutation bypasses sandbox' } : null,
    ),
    makeRail('no-protected-file-edit', 'rejects edits to protected files (scoring/policy/.github/safetyProfile)', (c) => {
      // Trust explicit protectedFilesTouched, but also re-derive from touchedFiles
      // so a mutation cannot hide a protected edit by leaving the flag list empty.
      // Coerce to arrays so a malformed (untyped) candidate fails CLOSED, not open.
      const derived = (c.touchedFiles ?? []).filter(isProtectedPath);
      const hits = [...new Set([...(c.protectedFilesTouched ?? []), ...derived])];
      return hits.length > 0
        ? { railId: 'no-protected-file-edit', message: `mutation touches protected files: ${hits.join(', ')}` }
        : null;
    }),
  ];
  return Object.freeze(rails);
}

// ─────────────────────────────────────────────────────────────────────────────
// The frozen registry. evaluate() runs every rail and aggregates ALL violations;
// the candidate must clear every rail to be eligible for benchmarking.
// ─────────────────────────────────────────────────────────────────────────────

/** A frozen registry of safety rails. */
export class RailRegistry {
  private readonly _rails: readonly SafetyRail[];

  constructor(rails?: readonly SafetyRail[]) {
    this._rails = Object.freeze((rails ?? builtinRails()).slice());
    Object.freeze(this); // the registry instance itself is immutable
  }

  /** The rails in this registry (frozen). */
  rails(): readonly SafetyRail[] {
    return this._rails;
  }

  /** Run every rail; ok only if no rail trips. Returns all violations. */
  evaluate(c: CandidateChange): { ok: boolean; violations: RailViolation[] } {
    const violations: RailViolation[] = [];
    for (const rail of this._rails) {
      const v = rail.check(c);
      if (v) violations.push(v);
    }
    return { ok: violations.length === 0, violations };
  }

  /**
   * Proves the rails cannot be altered. Attempts to mutate a frozen rail's id;
   * in strict mode (ESM is always strict) this THROWS, which we propagate so a
   * test can assert immutability via expect(() => reg.tryMutateRail()).toThrow().
   * If a host somehow permitted the write, we return false (mutation rejected).
   */
  tryMutateRail(): never | boolean {
    const rail = this._rails[0];
    // Strict-mode write to a frozen, read-only property → TypeError (thrown).
    (rail as { id: string }).id = 'tampered';
    return false; // unreachable in strict mode; defensive return otherwise
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-benchmark gate. The single call the harness makes before spending compute.
// ─────────────────────────────────────────────────────────────────────────────

/** True if the candidate MUST be rejected before any benchmark run.
 *  The immutable builtin battery is ALWAYS enforced, even if a caller passes a
 *  custom (or deliberately stripped) registry — rails are not in the mutation
 *  surface, so they cannot be disabled by swapping the registry. */
export function rejectsBeforeBenchmark(c: CandidateChange, reg: RailRegistry = new RailRegistry()): boolean {
  const builtinViolated = !new RailRegistry().evaluate(c).ok; // non-negotiable battery
  return builtinViolated || !reg.evaluate(c).ok;
}
