// SPDX-License-Identifier: MIT
//
// @metaharness/projects — optimized DEFENSIVE zero-day discovery harness.
// Pipeline: cheap static + LLM triage → frontier LLM proposes a concrete PROOF
// input → execution VERIFIES it (a real crash / invariant break) → only
// execution-confirmed weaknesses are reported. The verifier is the anti-
// hallucination spine: an LLM claim with no working proof is discarded. Strictly
// defensive — we demonstrate that a weakness EXISTS (and emit only the exception
// CLASS as evidence), never a weaponized exploit.
//
// All lanes are INJECTED (triage/propose/verify/cost), so this module is pure and
// deterministically unit-testable with no LLM and no code execution. The real
// wiring (OpenRouter lanes + isolated-subprocess verifier) lives in
// bench/zero-day-discovery.bench.mjs.

import { round6 } from './core.js';

export interface CodeTarget {
  path: string;
  language: 'python';
  source: string;
}

/** A suspected weakness site from triage (cheap static/LLM pass). */
export interface TriageCandidate {
  fn: string;
  weakness: string; // e.g. 'CWE-369 divide-by-zero', 'CWE-125 out-of-bounds'
  rationale: string;
}

/** A concrete, defensive PROOF: an input expected to break a safety invariant. */
export interface ProofProposal {
  fn: string;
  args: unknown[];
  expectedProblem: string; // human-readable; the class is confirmed by execution
}

/** The outcome of executing a proof against the target (real verification). */
export interface VerifyOutcome {
  triggered: boolean;
  /** Exception class only (defensive — never the payload/exploit). */
  evidenceClass?: string;
}

export interface VerifiedFinding {
  fn: string;
  weakness: string;
  source: 'static' | 'runtime';
  verified: boolean;
  evidenceClass?: string;
  proofArgsRedacted?: boolean; // proof exists but is intentionally not emitted
}

export interface DiscoveryLanes {
  /** Optional static channel (e.g. real Semgrep) — its findings are tool-verified. */
  staticScan?: (t: CodeTarget) => VerifiedFinding[];
  /** Cheap triage: rank suspected weakness sites. */
  triage: (t: CodeTarget) => Promise<TriageCandidate[]>;
  /** Frontier reasoning: propose a concrete proof input (or null if none found). */
  propose: (t: CodeTarget, c: TriageCandidate) => Promise<ProofProposal | null>;
  /** Execution verifier: actually run the proof; report whether it broke. */
  verify: (t: CodeTarget, p: ProofProposal) => VerifyOutcome;
  /** Cumulative LLM cost-units spent so far (for the cost ledger). */
  cost: () => number;
}

export interface DiscoveryResult {
  target: string;
  findings: VerifiedFinding[];
  candidates: number;
  proposed: number;
  verified: number;
  costUnits: number;
  costPerVerifiedFinding: number | null;
}

export interface DiscoveryOptions {
  /** Cap how many triage candidates get escalated to the frontier lane (cost guard). */
  maxEscalations?: number;
}

/**
 * Run the defensive discovery pipeline. Findings are de-duplicated by (fn,source).
 * Only execution-confirmed runtime weaknesses (plus tool-verified static ones) are
 * reported — unproven LLM hypotheses are dropped.
 */
export async function runDiscovery(
  target: CodeTarget,
  lanes: DiscoveryLanes,
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const maxEscalations = opts.maxEscalations ?? Infinity;
  const findings: VerifiedFinding[] = [];
  const seen = new Set<string>();
  const add = (f: VerifiedFinding) => {
    const k = `${f.source}:${f.fn}:${f.weakness}`;
    if (!seen.has(k)) {
      seen.add(k);
      findings.push(f);
    }
  };

  // Channel 1: static tool findings are already verified by the tool.
  for (const f of lanes.staticScan?.(target) ?? []) add({ ...f, source: 'static', verified: true });

  // Channel 2: triage → escalate → propose proof → VERIFY by execution.
  const candidates = await lanes.triage(target);
  let proposed = 0;
  let escalated = 0;
  for (const c of candidates) {
    if (escalated >= maxEscalations) break;
    escalated += 1;
    const proof = await lanes.propose(target, c);
    if (!proof) continue; // frontier found no concrete proof → not a confirmed finding
    proposed += 1;
    const outcome = lanes.verify(target, proof);
    if (outcome.triggered) {
      add({
        fn: c.fn,
        weakness: c.weakness,
        source: 'runtime',
        verified: true,
        evidenceClass: outcome.evidenceClass,
        proofArgsRedacted: true, // a working proof exists; we deliberately do not emit it
      });
    }
  }

  const verified = findings.filter((f) => f.verified).length;
  const costUnits = round6(lanes.cost());
  return {
    target: target.path,
    findings,
    candidates: candidates.length,
    proposed,
    verified,
    costUnits,
    costPerVerifiedFinding: verified > 0 ? round6(costUnits / verified) : null,
  };
}
