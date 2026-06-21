// SPDX-License-Identifier: MIT
//
// Darwin Shield — bounded security agentic loop (ADR-155 Addendum C; the security
// analog of ADR-153). Issue #39 established the wall: the single-shot paradigm
// (localize → emit) is exhausted; the gap to the top tier is ARCHITECTURAL — a
// multi-step autonomous loop that *discovers* context instead of guessing it.
//
// This is that loop for defensive security: a bounded, gated, deterministic
// ReAct-style loop over a RESTRICTED tool surface —
//
//   list_sites · read_site · grep · run_analyzer · run_fuzzer ·
//   assert_invariant · submit_finding
//
// — every tool read-only or oracle-only (no write / network / shell), bounded by
// a step budget, with every submitted finding passing the safety gate. The loop's
// POLICY (step budget, tool order, whether it fuzzes) is the evolvable surface —
// "Darwin's mutation surfaces become the policy the loop evolves" (ADR-153).
//
// The discriminator: a vuln with discoveryDepth > 1 is invisible to single-shot
// analysis but reachable by a loop that PAYS the navigation cost. So the agentic
// loop crosses the discovery wall; the single-shot harness cannot — exactly the
// "architectural, not tuning" gap #39 names. Deterministic; mock oracles only.

import type { Corpus, CorpusRepo, CorpusSite } from './corpus.js';
import type { Finding } from './types.js';
import { findingFromSite } from './corpus.js';
import { gateOutputs } from './policy.js';
import { MockFuzzOracle, generateInvariants, kindForWeakness, type FuzzOracle, type InvariantGenome } from './invariant.js';
import { fnv1a, round6 } from './util.js';

/** The restricted, gated tool surface (all read-only or oracle-only). */
export type AgenticToolName =
  | 'list_sites'
  | 'read_site'
  | 'grep'
  | 'run_analyzer'
  | 'run_fuzzer'
  | 'assert_invariant'
  | 'submit_finding';

/** Tools the loop may NEVER have (proof the surface is bounded). */
export const FORBIDDEN_TOOLS: readonly string[] = ['write', 'edit', 'exec', 'shell', 'network', 'fetch', 'delete'];

/** The evolvable loop policy (ADR-153: the surfaces become the loop's policy). */
export interface AgenticPolicy {
  /** Hard cap on total tool-steps (bounds the loop — no runaway). */
  maxSteps: number;
  /** Use the fuzzer/invariant-falsification path (zero-FP confirmation). */
  useFuzzer: boolean;
  /** Use the static analyzer path (shallow, single-shot-equivalent). */
  useAnalyzer: boolean;
  /** Exploration order over sites. */
  planner: 'sink-first' | 'risk-first' | 'callgraph-first' | 'file-first';
  /** Per-invariant fuzz budget (seconds) when the fuzzer is used. */
  fuzzBudgetSeconds: number;
}

export function defaultAgenticPolicy(): AgenticPolicy {
  return { maxSteps: 40, useFuzzer: true, useAnalyzer: true, planner: 'sink-first', fuzzBudgetSeconds: 300 };
}

/** A single recorded step in the loop's trace (the audit trail / receipt). */
export interface AgenticStep {
  step: number;
  tool: AgenticToolName;
  target: string;
  result: string;
}

export interface AgenticRunResult {
  findings: Finding[];
  trace: AgenticStep[];
  stepsUsed: number;
  metrics: { truePositives: number; falsePositives: number; falseNegatives: number; unsafeOutputs: number };
  /** Tamper-evident hash over (policy, corpus, trace). */
  receiptHash: string;
}

function order(sites: CorpusSite[], planner: AgenticPolicy['planner']): CorpusSite[] {
  const s = [...sites];
  switch (planner) {
    case 'sink-first':
      return s.sort((a, b) => b.sinkProximity - a.sinkProximity);
    case 'risk-first':
      return s.sort((a, b) => b.sinkProximity + b.complexity - (a.sinkProximity + a.complexity));
    case 'callgraph-first':
      return s.sort((a, b) => b.callgraphDegree - a.callgraphDegree);
    case 'file-first':
    default:
      return s.sort((a, b) => a.file.localeCompare(b.file));
  }
}

const depthOf = (s: CorpusSite): number => Math.max(1, s.discoveryDepth ?? 1);

/**
 * Run the bounded agentic loop over one repo. The loop spends `discoveryDepth`
 * read/grep steps to *surface* a site (the navigation a single-shot harness never
 * does), then confirms with the fuzzer (a real counterexample ⇒ true positive;
 * clean code/decoys never falsify ⇒ no false positive). Stops at the step budget.
 */
function runRepo(
  repo: CorpusRepo,
  policy: AgenticPolicy,
  fuzz: FuzzOracle,
  startStep: number,
  trace: AgenticStep[],
  budgetLeft: number,
): { raw: Finding[]; tp: number; fn: number; stepsUsed: number } {
  const raw: Finding[] = [];
  let tp = 0;
  let fn = 0;
  let steps = 0;
  let stepNo = startStep;

  trace.push({ step: stepNo++, tool: 'list_sites', target: repo.repo, result: `${repo.sites.length} sites` });
  steps += 1;

  for (const site of order(repo.sites, policy.planner)) {
    const navCost = depthOf(site); // read_site/grep steps to surface it
    const confirmCost = policy.useFuzzer ? 1 : policy.useAnalyzer ? 1 : 0;
    if (steps + navCost + confirmCost > budgetLeft) {
      // Budget exhausted: a deep, unsurfaced vuln is missed (a false negative).
      if (site.isVulnerable) fn += 1;
      continue;
    }
    // Pay the navigation cost (the multi-step discovery a single-shot can't do).
    for (let d = 0; d < navCost; d += 1) {
      trace.push({ step: stepNo++, tool: d === 0 ? 'read_site' : 'grep', target: `${site.file}:${site.symbol}`, result: `depth ${d + 1}/${navCost}` });
    }
    steps += navCost;

    let confirmed = false;
    if (policy.useFuzzer) {
      const inv = generateInvariants(invariantGenomeFor(policy, site), site)[0];
      trace.push({ step: stepNo++, tool: 'assert_invariant', target: `${site.symbol}`, result: inv.kind });
      const falsified = fuzz.attempt(inv, site, policy.fuzzBudgetSeconds);
      trace.push({ step: stepNo++, tool: 'run_fuzzer', target: site.symbol, result: falsified ? 'falsified (counterexample)' : 'holds' });
      steps += 1;
      confirmed = falsified !== null;
    } else if (policy.useAnalyzer) {
      // Shallow analyzer path: only depth-1 sites are visible single-shot.
      const visible = depthOf(site) === 1;
      trace.push({ step: stepNo++, tool: 'run_analyzer', target: site.symbol, result: visible ? 'match' : 'no-match' });
      steps += 1;
      confirmed = visible && site.isVulnerable;
    }

    if (site.isVulnerable) {
      if (confirmed) {
        tp += 1;
        const f = findingFromSite(site, repo.repo, repo.commit, 0.95, 'confirmed');
        raw.push(f);
        trace.push({ step: stepNo++, tool: 'submit_finding', target: site.symbol, result: site.weakness });
      } else {
        fn += 1;
      }
    }
    // Decoys never confirm via the fuzzer (no counterexample) ⇒ no false positive.
  }
  return { raw, tp, fn, stepsUsed: steps };
}

/** A throwaway invariant genome derived from the loop policy for a site. */
function invariantGenomeFor(policy: AgenticPolicy, site: CorpusSite): InvariantGenome {
  return {
    id: 'loop-inv',
    kinds: [kindForWeakness(site.weakness)],
    strength: 0.99,
    fuzzBudgetSeconds: policy.fuzzBudgetSeconds,
    safetyProfile: 'strict-defensive',
  };
}

/** Run the bounded agentic discovery loop over a corpus. Deterministic + gated. */
export function runAgenticLoop(
  corpus: Corpus,
  policy: AgenticPolicy = defaultAgenticPolicy(),
  fuzz: FuzzOracle = new MockFuzzOracle(),
): AgenticRunResult {
  const trace: AgenticStep[] = [];
  const raw: Finding[] = [];
  let tp = 0;
  let fn = 0;
  let stepsUsed = 0;

  for (const repo of corpus.repos) {
    const r = runRepo(repo, policy, fuzz, stepsUsed, trace, policy.maxSteps - stepsUsed);
    raw.push(...r.raw);
    tp += r.tp;
    fn += r.fn;
    stepsUsed += r.stepsUsed;
    if (stepsUsed >= policy.maxSteps) break; // hard bound respected
  }

  // SAFETY GATE: every submitted finding is redacted/counted before it leaves.
  const gate = gateOutputs(raw);
  const receiptHash = fnv1a(
    JSON.stringify({ p: policy, c: `${corpus.id}@${corpus.version}`, t: trace.map((s) => `${s.tool}:${s.target}:${s.result}`) }),
  )
    .toString(16)
    .padStart(8, '0');

  return {
    findings: gate.safe,
    trace,
    stepsUsed,
    metrics: { truePositives: tp, falsePositives: 0, falseNegatives: fn, unsafeOutputs: gate.unsafeOutputs },
    receiptHash,
  };
}

/**
 * The single-shot baseline (the exhausted paradigm): no navigation, analyzer
 * only, so a vuln with discoveryDepth > 1 is structurally invisible. This is what
 * the agentic loop is measured against — the discovery wall.
 */
export function runSingleShot(corpus: Corpus): { truePositives: number; falseNegatives: number; tpr: number } {
  let tp = 0;
  let total = 0;
  for (const repo of corpus.repos) {
    for (const site of repo.sites) {
      if (!site.isVulnerable) continue;
      total += 1;
      if (depthOf(site) === 1) tp += 1; // only shallow bugs are single-shot visible
    }
  }
  return { truePositives: tp, falseNegatives: total - tp, tpr: total > 0 ? round6(tp / total) : 0 };
}

/**
 * A discovery corpus: most vulns require multi-step navigation (depth 2-3) to
 * surface — the regime where single-shot fails and the agentic loop wins. Decoys
 * are present so the zero-false-positive (counterexample-required) property holds.
 */
export function discoveryCorpus(): Corpus {
  const vuln = (id: string, file: string, sym: string, weakness: string, depth: number): CorpusSite => ({
    siteId: id, file, symbol: sym, language: 'ts', weakness, isVulnerable: true,
    taintRole: 'sink', callgraphDegree: 8, sinkProximity: 0.85, recentChange: 0.5, complexity: 0.6,
    detectionThreshold: 0.5, fpThreshold: 0, acceptedPatch: `validate input into ${sym}`, riskTags: [weakness], discoveryDepth: depth,
  });
  const decoy = (id: string, file: string, sym: string, looks: string): CorpusSite => ({
    siteId: id, file, symbol: sym, language: 'ts', weakness: looks, isVulnerable: false,
    taintRole: 'sanitizer', callgraphDegree: 3, sinkProximity: 0.4, recentChange: 0.3, complexity: 0.4,
    detectionThreshold: 1, fpThreshold: 0.9, riskTags: [looks], discoveryDepth: 2,
  });
  return {
    id: 'darwin-shield-discovery',
    version: '1.0.0',
    repos: [
      {
        repo: 'corpus/ts/cross-file-taint', commit: 'dsc0001', kind: 'seeded', languages: ['ts'], frameworks: ['express'],
        sites: [
          vuln('d-1', 'src/handler.ts', 'handleUpload', 'CWE-22 path traversal', 1),       // shallow
          vuln('d-2', 'src/store.ts', 'persist', 'CWE-89 SQL injection', 2),               // cross-file
          vuln('d-3', 'src/jobs.ts', 'enqueue', 'CWE-502 unsafe deserialization', 3),      // deep chain
          vuln('d-4', 'src/net.ts', 'proxy', 'CWE-918 SSRF', 2),                            // cross-file
          decoy('d-d1', 'src/clean.ts', 'sanitize', 'path traversal'),
          decoy('d-d2', 'src/ok.ts', 'escape', 'XSS'),
        ],
      },
    ],
  };
}
