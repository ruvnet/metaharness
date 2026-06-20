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
  /** Severity heuristic (see severityOf): a bare TypeError from wrong-arg-type is
   *  trivially reachable for almost any function, so it ranks LOW; genuine
   *  edge-case logic crashes (div-by-zero, OOB, key/value errors) rank higher. */
  severity?: 'low' | 'medium' | 'high';
  proofArgsRedacted?: boolean; // proof exists but is intentionally not emitted
}

/** Classify a runtime crash's significance from its exception class. A TypeError
 *  is usually "you passed the wrong type" (reachable for nearly any function), so
 *  it is LOW; the classic edge-case faults are more meaningful robustness/DoS bugs. */
export function severityOf(evidenceClass?: string): 'low' | 'medium' {
  if (!evidenceClass || evidenceClass === 'TypeError' || evidenceClass === 'AttributeError') return 'low';
  return 'medium';
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
  /** Candidates skipped because the static channel already verified that site. */
  skipped: number;
  costUnits: number;
  costPerVerifiedFinding: number | null;
}

export interface DiscoveryOptions {
  /** Cap how many triage candidates get escalated to the frontier lane (cost guard). */
  maxEscalations?: number;
  /**
   * Opt-in: skip the expensive frontier escalation (propose/verify) for any triage
   * candidate whose `fn` already appears among the static findings — the static
   * channel already verified that site, so a frontier call there is wasted. Default
   * false (behavior-preserving).
   */
  skipStaticallyCovered?: boolean;
  /**
   * Max number of `propose` (frontier) calls to run concurrently during escalation.
   * Purely a latency optimization — results stay deterministic because verification
   * and finding insertion happen in stable candidate order. Default 4.
   */
  concurrency?: number;
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
  const skipStaticallyCovered = opts.skipStaticallyCovered ?? false;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
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

  // The set of fn sites the static channel already verified — escalating these
  // to the frontier lane is wasted work when skipStaticallyCovered is on.
  const staticFns = new Set(findings.filter((f) => f.source === 'static').map((f) => f.fn));

  // Channel 2: triage → escalate → propose proof → VERIFY by execution.
  const candidates = await lanes.triage(target);

  // Select the candidates to escalate, in candidate order, honoring maxEscalations
  // and (optionally) skipping statically-covered sites. We build the work list first
  // so escalation order is deterministic regardless of concurrency.
  let skipped = 0;
  const toEscalate: TriageCandidate[] = [];
  for (const c of candidates) {
    if (toEscalate.length >= maxEscalations) break;
    if (skipStaticallyCovered && staticFns.has(c.fn)) {
      skipped += 1;
      continue; // static channel already verified this site — don't spend a frontier call
    }
    toEscalate.push(c);
  }

  // Run `propose` (the frontier lane) with bounded concurrency to cut wall-clock
  // latency. Proposals are collected indexed by candidate position so that the
  // downstream verify + finding insertion runs in STABLE candidate order, making
  // the result independent of async completion timing.
  const proposals: (ProofProposal | null)[] = new Array(toEscalate.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= toEscalate.length) return;
      proposals[i] = await lanes.propose(target, toEscalate[i]);
    }
  };
  const pool = Math.min(concurrency, toEscalate.length);
  await Promise.all(Array.from({ length: pool }, () => worker()));

  // Verify + insert in candidate order (verify stays synchronous/ordered).
  let proposed = 0;
  for (let i = 0; i < toEscalate.length; i += 1) {
    const proof = proposals[i];
    if (!proof) continue; // frontier found no concrete proof → not a confirmed finding
    proposed += 1;
    const outcome = lanes.verify(target, proof);
    if (outcome.triggered) {
      const c = toEscalate[i];
      add({
        fn: c.fn,
        weakness: c.weakness,
        source: 'runtime',
        verified: true,
        evidenceClass: outcome.evidenceClass,
        severity: severityOf(outcome.evidenceClass),
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
    skipped,
    costUnits,
    costPerVerifiedFinding: verified > 0 ? round6(costUnits / verified) : null,
  };
}
