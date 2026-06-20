// SPDX-License-Identifier: MIT
//
// Darwin Shield — bounded self-writing extension, Phase 1 (ADR-155 Addendum).
//
//   The model proposes. The harness disposes.
//
// Configuration search optimizes existing levers; it cannot invent new DETECTION
// strategies. This module adds an OPT-IN path to *generate* defensive detection
// logic (Phase 1: detection-rule synthesis), judged by an oracle and promoted
// only through the existing paired-bootstrap gate — never replacing the referee.
//
// HARD BOUNDARIES (the safety layer is the referee, outside the editable surface):
//   • editable surfaces are an allowlist of DETECTOR artifacts only;
//   • policy / safety / grader / statistics / corpus / receipt-verifier /
//     promotion / sandbox / network / credential code is FORBIDDEN to generate;
//   • generated artifacts are CANDIDATES, not authority — untrusted until
//     validated, replayable from a full receipt, and statistically superior.
//
// Phase 1 is interface + a DETERMINISTIC mock generator + a mock oracle, so the
// whole flow is reproducible and testable with no LLM and no real analyzers.
// Phase 2 swaps in a real Semgrep oracle behind the identical gate.

import type { Corpus, CorpusSite } from './corpus.js';
import { fitness } from './scoring.js';
import { COST_BUDGET, TIME_BUDGET } from './scoring.js';
import { bootstrapDelta } from './stats.js';
import { detectUnsafe } from './policy.js';
import { clamp, fnv1a, round6 } from './util.js';

/** The allowlisted editable surfaces (ADR-155 Addendum §Decision). */
export type ShieldSurface =
  | 'semgrep-rule'
  | 'codeql-snippet'
  | 'taint-heuristic'
  | 'reviewer-prompt'
  | 'detector-config'
  | 'adapter-normalizer';

export const EDITABLE_SURFACES: readonly ShieldSurface[] = [
  'semgrep-rule',
  'codeql-snippet',
  'taint-heuristic',
  'reviewer-prompt',
  'detector-config',
  'adapter-normalizer',
] as const;

/**
 * Forbidden generation targets — the referee. A generated artifact that names any
 * of these in a write/modify/import context is rejected outright (ADR-155
 * Addendum §Forbidden generated artifacts). The safety machinery is never an
 * evolutionary surface.
 */
export const FORBIDDEN_TARGETS: readonly string[] = [
  'policy',
  'safety',
  'grader',
  'bootstrap',
  'statistic',
  'corpus',
  'receipt',
  'promotion',
  'sandbox',
  'isolation',
  'network',
  'credential',
];

const MAX_ARTIFACT_BYTES = 32 * 1024;

/** Patterns that would let an artifact escape its sandbox or touch the referee. */
const ESCAPE_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /\beval\s*\(|\bnew\s+Function\b/i, reason: 'dynamic code execution' },
  { re: /\brequire\s*\(|\bimport\s*\(/i, reason: 'dynamic module load' },
  { re: /\bchild_process\b|\bexecSync\b|\bspawn\b/i, reason: 'process execution' },
  { re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\/dev\/tcp\//i, reason: 'network access' },
  { re: /\bnode:(fs|net|http|https|child_process|vm)\b|from\s+['"](fs|net|http|https|vm)['"]/i, reason: 'restricted builtin' },
  { re: /\bprocess\s*[.[]\s*['"`]?\s*env\b/i, reason: 'environment access' },
];

/** True iff a surface is on the Phase-1 allowlist. */
export function isEditableSurface(surface: string): surface is ShieldSurface {
  return (EDITABLE_SURFACES as readonly string[]).includes(surface);
}

/**
 * Static validation of a generated detector artifact BEFORE it is trusted
 * (ADR-155 Addendum §Promotion gate 7-9). Returns violations; empty ⇒ admissible.
 * Independent of the oracle (defense in depth): a candidate that fails here is
 * archived but never promoted.
 */
export function validateGeneratedShieldCode(surface: string, artifact: string): string[] {
  const v: string[] = [];
  if (!isEditableSurface(surface)) v.push(`surface "${surface}" is not an allowlisted editable surface`);
  if (artifact.trim().length === 0) v.push('empty artifact');
  if (artifact.length > MAX_ARTIFACT_BYTES) v.push(`artifact too large (${artifact.length} > ${MAX_ARTIFACT_BYTES})`);

  // Never generate the referee. Flag a forbidden target used in a write/import
  // context (prose mentioning "policy" in a reviewer prompt is fine).
  for (const target of FORBIDDEN_TARGETS) {
    const re = new RegExp(`\\b(write|modify|edit|patch|import|require|overwrite|delete)\\b[^\\n]{0,40}\\b${target}`, 'i');
    if (re.test(artifact)) v.push(`forbidden target "${target}" referenced for modification`);
  }
  // Executable-ish surfaces must not escape the sandbox.
  if (surface === 'taint-heuristic' || surface === 'adapter-normalizer' || surface === 'detector-config') {
    for (const { re, reason } of ESCAPE_PATTERNS) if (re.test(artifact)) v.push(`sandbox escape: ${reason}`);
  }
  // A defensive artifact never carries a weaponized payload.
  for (const r of detectUnsafe(artifact)) v.push(`unsafe content: ${r}`);
  return [...new Set(v)];
}

/** A parsed detector rule (the inspectable, auditable form an artifact encodes). */
export interface DetectorRule {
  /** Weakness classes the rule covers (matched against corpus site weaknesses). */
  covers: string[];
  /** 0..1 precision — higher rejects more decoys (fewer false positives). */
  precision: number;
}

/**
 * Parse a generated artifact into a rule. Format is a tiny, dependency-free,
 * inspectable text block (no eval, no YAML dep):
 *   covers: CWE-89, CWE-79
 *   precision: 0.9
 */
export function parseDetector(artifact: string): DetectorRule {
  const coversMatch = artifact.match(/covers\s*:\s*([^\n]+)/i);
  const precMatch = artifact.match(/precision\s*:\s*([0-9.]+)/i);
  const covers = coversMatch
    ? coversMatch[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
  const precision = precMatch ? clamp(Number(precMatch[1]) || 0, 0, 1) : 0;
  return { covers, precision };
}

/** The full, replayable receipt for a generated candidate (§Determinism contract). */
export interface ShieldGenReceipt {
  prompt: string;
  model: string;
  seed: number;
  artifact: string;
  formatterOutput: string;
  validatorOutput: string[];
  testOutput: string;
  corpusVersion: string;
  toolVersions: Record<string, string>;
  receiptHash: string;
}

/** A generated detector candidate (artifact + provenance), pre-evaluation. */
export interface GeneratedDetectorCandidate {
  id: string;
  surface: ShieldSurface;
  artifact: string;
  prompt: string;
  model: string;
  seed: number;
}

/** The generator hook. The deterministic mock is the Phase-1 default. */
export interface ShieldCodeGenerator {
  generateDetector(input: {
    surface: ShieldSurface;
    /** Target weakness classes / repo context to cover. */
    targets: string[];
    seed?: number;
  }): GeneratedDetectorCandidate;
}

/**
 * A deterministic, dependency-free stand-in for an LLM detector generator: emits
 * a rule covering the requested targets with a precision derived from the seed.
 * Reproducible (same input ⇒ identical artifact), so Phase 1 has full replay.
 */
export class DeterministicDetectorGenerator implements ShieldCodeGenerator {
  readonly model = 'deterministic-mock';

  generateDetector(input: { surface: ShieldSurface; targets: string[]; seed?: number }): GeneratedDetectorCandidate {
    const seed = input.seed ?? 0;
    // Precision rises with seed quality, capped — a stand-in for prompt quality.
    const precision = round6(clamp(0.6 + (seed % 5) * 0.1, 0, 0.99));
    const artifact = [
      `# generated ${input.surface}`,
      `covers: ${input.targets.join(', ')}`,
      `precision: ${precision}`,
    ].join('\n');
    const prompt = `synthesize a ${input.surface} covering: ${input.targets.join(', ')}`;
    const id = `cand-${fnv1a(`${input.surface}|${input.targets.join(',')}|${seed}`).toString(16)}`;
    return { id, surface: input.surface, artifact, prompt, model: this.model, seed };
  }
}

/** A detector oracle: run a rule over a corpus and report findings vs labels. */
export interface DetectorOracle {
  readonly name: string;
  readonly version: string;
  /** Per-repo (truePositives, falsePositives, ...) for the rule. */
  evaluate(rule: DetectorRule, corpus: Corpus): Array<{ repo: string; tp: number; fp: number; fn: number; vulns: number; decoys: number }>;
}

/**
 * A deterministic MOCK oracle (Phase 1). A vulnerable site is a true positive
 * when the rule covers its weakness; a decoy leaks as a false positive when the
 * rule's precision is below the decoy's resistance threshold. No real Semgrep —
 * Phase 2 implements the same interface against `semgrep --json`.
 */
export class MockDetectorOracle implements DetectorOracle {
  readonly name = 'mock-detector-oracle';
  readonly version = '1.0.0';

  evaluate(rule: DetectorRule, corpus: Corpus) {
    const covers = new Set(rule.covers.map((c) => c.toLowerCase()));
    const matches = (s: CorpusSite) =>
      covers.has(s.weakness.toLowerCase()) || rule.covers.some((c) => s.weakness.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(s.weakness.toLowerCase()));
    return corpus.repos.map((repo) => {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      let vulns = 0;
      let decoys = 0;
      for (const s of repo.sites) {
        if (s.isVulnerable) {
          vulns += 1;
          if (matches(s)) tp += 1;
          else fn += 1;
        } else {
          decoys += 1;
          if (matches(s) && rule.precision < s.fpThreshold) fp += 1;
        }
      }
      return { repo: repo.repo, tp, fp, fn, vulns, decoys };
    });
  }
}

/** Build the full determinism-contract receipt for a candidate + oracle run. */
export function captureReceipt(
  candidate: GeneratedDetectorCandidate,
  validatorOutput: string[],
  testOutput: string,
  corpus: Corpus,
  oracle: DetectorOracle,
): ShieldGenReceipt {
  const toolVersions = { [oracle.name]: oracle.version };
  const base = {
    prompt: candidate.prompt,
    model: candidate.model,
    seed: candidate.seed,
    artifact: candidate.artifact,
    formatterOutput: candidate.artifact.trim(),
    validatorOutput,
    testOutput,
    corpusVersion: `${corpus.id}@${corpus.version}`,
    toolVersions,
  };
  const receiptHash = fnv1a(JSON.stringify(base)).toString(16).padStart(8, '0');
  return { ...base, receiptHash };
}

/** Per-repo fitness samples produced by running a rule through the oracle. */
function oracleFitnessSamples(rule: DetectorRule, corpus: Corpus, oracle: DetectorOracle, baselineFpRate: number): number[] {
  return oracle.evaluate(rule, corpus).map((r) => {
    const reproduced = r.tp; // mock: a covered vuln is reproducible by the rule
    return fitness({
      metrics: {
        truePositives: r.tp,
        falsePositives: r.fp,
        falseNegatives: r.fn,
        reproduced,
        patchesPassing: r.tp,
        patchesProposed: r.tp,
        toolAgreements: r.tp,
        novelFindings: r.tp,
        unsafeOutputs: 0,
        costUnits: 5,
        timeToFinding: 1,
      },
      groundTruthCount: r.vulns,
      decoyCount: r.decoys,
      baselineFalsePositiveRate: baselineFpRate,
      costBudget: COST_BUDGET,
      timeBudget: TIME_BUDGET,
    }).fitness;
  });
}

function rates(rule: DetectorRule, corpus: Corpus, oracle: DetectorOracle): { tpr: number; fpr: number; tp: number } {
  const per = oracle.evaluate(rule, corpus);
  const tp = per.reduce((a, r) => a + r.tp, 0);
  const vulns = per.reduce((a, r) => a + r.vulns, 0);
  const fp = per.reduce((a, r) => a + r.fp, 0);
  const decoys = per.reduce((a, r) => a + r.decoys, 0);
  return { tpr: vulns > 0 ? tp / vulns : 0, fpr: decoys > 0 ? fp / decoys : 0, tp };
}

/** One gate result in the candidate promotion decision. */
export interface CandidateGate {
  name: string;
  pass: boolean;
  detail: string;
}

/** The full promotion verdict for a generated candidate (ADR-155 Addendum). */
export interface CandidateVerdict {
  candidate: GeneratedDetectorCandidate;
  receipt: ShieldGenReceipt;
  gates: CandidateGate[];
  promote: boolean;
}

export interface EvaluateOptions {
  /** Easy corpus (saturation check) and hard corpus (real frontier). */
  easyCorpus: Corpus;
  hardCorpus: Corpus;
  baselineFpRate?: number;
  /** Max allowed FP-rate regression vs the incumbent (default 0). */
  fpRegressionThreshold?: number;
  /** Runtime budget in oracle-evaluations (default 64). */
  runtimeBudget?: number;
  seed?: number;
}

/**
 * Evaluate a generated candidate against the incumbent detector through ALL ten
 * promotion gates (ADR-155 Addendum §Promotion gate). A candidate replaces the
 * incumbent only if every gate passes; otherwise it is archived (receipt kept),
 * never promoted. Deterministic and replayable.
 */
export function evaluateCandidate(
  incumbent: DetectorRule,
  candidate: GeneratedDetectorCandidate,
  oracle: DetectorOracle,
  opts: EvaluateOptions,
): CandidateVerdict {
  const baselineFpRate = opts.baselineFpRate ?? 0.5;
  const fpThreshold = opts.fpRegressionThreshold ?? 0;
  const runtimeBudget = opts.runtimeBudget ?? 64;
  const seed = opts.seed ?? 0;

  const validatorOutput = validateGeneratedShieldCode(candidate.surface, candidate.artifact);
  const rule = parseDetector(candidate.artifact);

  // Oracle runs (counted against the runtime budget).
  let evals = 0;
  const easyNew = oracleFitnessSamples(rule, opts.easyCorpus, oracle, baselineFpRate); evals += opts.easyCorpus.repos.length;
  const easyOld = oracleFitnessSamples(incumbent, opts.easyCorpus, oracle, baselineFpRate); evals += opts.easyCorpus.repos.length;
  const hardNew = oracleFitnessSamples(rule, opts.hardCorpus, oracle, baselineFpRate); evals += opts.hardCorpus.repos.length;
  const hardOld = oracleFitnessSamples(incumbent, opts.hardCorpus, oracle, baselineFpRate); evals += opts.hardCorpus.repos.length;

  const allNew = [...easyNew, ...hardNew];
  const allOld = [...easyOld, ...hardOld];
  const boot = bootstrapDelta(allOld, allNew, { seed });

  const newHard = rates(rule, opts.hardCorpus, oracle);
  const oldHard = rates(incumbent, opts.hardCorpus, oracle);
  const newAll = rates(rule, opts.easyCorpus, oracle);
  const oldAll = rates(incumbent, opts.easyCorpus, oracle);

  const testOutput = `easyTPR ${round6(newAll.tpr)} hardTPR ${round6(newHard.tpr)} hardFPR ${round6(newHard.fpr)}`;
  const receipt = captureReceipt(candidate, validatorOutput, testOutput, opts.easyCorpus, oracle);
  // Replay: regenerate the receipt and compare the hash (byte-identical).
  const replay = captureReceipt(candidate, validatorOutput, testOutput, opts.easyCorpus, oracle);

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const fpRegression = newHard.fpr - oldHard.fpr;

  const gates: CandidateGate[] = [
    { name: 'paired bootstrap lower95 > 0', pass: boot.lower95 > 0, detail: `lower95 ${boot.lower95}, mean ${boot.meanDelta}, p ${boot.pValue}` },
    { name: 'zero unsafe-output regression', pass: detectUnsafe(candidate.artifact).length === 0, detail: 'artifact carries no weaponized content' },
    { name: 'false-positive regression below threshold', pass: fpRegression <= fpThreshold, detail: `Δfpr ${round6(fpRegression)} ≤ ${fpThreshold}` },
    { name: 'true-positive improvement on a hard segment', pass: newHard.tp > oldHard.tp, detail: `hard TP ${oldHard.tp} → ${newHard.tp}` },
    { name: 'easy gains do not mask hard degradation', pass: mean(hardNew) >= mean(hardOld), detail: `hard mean ${round6(mean(hardOld))} → ${round6(mean(hardNew))}` },
    { name: 'receipt replay byte-identical', pass: replay.receiptHash === receipt.receiptHash, detail: receipt.receiptHash },
    { name: 'artifact passes static validation', pass: validatorOutput.length === 0, detail: validatorOutput.join('; ') || 'clean' },
    { name: 'artifact stays inside the allowlisted surface', pass: isEditableSurface(candidate.surface), detail: candidate.surface },
    { name: 'no forbidden target modified', pass: !validatorOutput.some((x) => x.startsWith('forbidden target')), detail: 'referee untouched' },
    { name: 'runtime budget respected', pass: evals <= runtimeBudget, detail: `${evals} ≤ ${runtimeBudget} oracle evals` },
  ];

  // Suppress the duplicate-of-easy improvement signal hint (keep newAll referenced).
  void oldAll;

  return { candidate, receipt, gates, promote: gates.every((g) => g.pass) };
}

/**
 * Phase-1 end-to-end flow: generate → validate → oracle → receipt → gate.
 * OPT-IN: nothing in the default Shield evolve/benchmark path calls this. The
 * deterministic config mutator remains the default search; this is the bounded
 * self-writing extension, invoked only when a caller explicitly opts in.
 */
export function synthesizeAndEvaluate(
  generator: ShieldCodeGenerator,
  surface: ShieldSurface,
  targets: string[],
  incumbent: DetectorRule,
  oracle: DetectorOracle,
  opts: EvaluateOptions,
): CandidateVerdict {
  const candidate = generator.generateDetector({ surface, targets, seed: opts.seed ?? 0 });
  return evaluateCandidate(incumbent, candidate, oracle, opts);
}
