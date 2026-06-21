// SPDX-License-Identifier: MIT
//
// Darwin Shield — REAL self-writing loop (ADR-155 Addendum A, Phase 2 §in-loop
// judge). Phase 2 first landed a real Semgrep oracle as a *standalone* check.
// This makes real Semgrep the JUDGE inside the promotion gate: a generated rule
// is run by actual `semgrep --json` over a multi-file labeled corpus, scored
// per-file, and promoted over the incumbent ONLY when the paired seeded bootstrap
// certifies superiority (lower-95% per-file delta > 0) with no false-positive
// regression and no unsafe content — the identical gate the mock path uses, now
// driven by a real tool. Optional: skips when semgrep is absent.

import { bootstrapDelta, type BootstrapResult } from './stats.js';
import { detectUnsafe } from './policy.js';
import { SemgrepDetectorOracle, type LabeledTarget } from './semgrep-oracle.js';
import { fnv1a, round6 } from './util.js';

/** A weakness pattern the generator can synthesize a real Semgrep rule for. */
export type RulePatternKey =
  | 'eval'
  | 'exec'
  | 'shell-true'
  | 'yaml-load'
  | 'pickle-loads'
  | 'os-system'
  | 'weak-hash'
  | 'mktemp';

/** Real Semgrep rule snippets, keyed by weakness. Defensive detection only. */
const RULE_SNIPPETS: Record<RulePatternKey, string> = {
  eval: `  - id: ds-eval
    languages: [python]
    severity: ERROR
    message: CWE-94 code injection via eval()
    pattern: eval(...)`,
  exec: `  - id: ds-exec
    languages: [python]
    severity: ERROR
    message: CWE-94 code injection via exec()
    pattern: exec(...)`,
  'shell-true': `  - id: ds-shell-true
    languages: [python]
    severity: ERROR
    message: CWE-78 OS command injection (shell=True)
    pattern: subprocess.Popen(..., shell=True)`,
  'yaml-load': `  - id: ds-yaml-load
    languages: [python]
    severity: ERROR
    message: CWE-502 unsafe deserialization (yaml.load)
    pattern: yaml.load(...)`,
  'pickle-loads': `  - id: ds-pickle-loads
    languages: [python]
    severity: ERROR
    message: CWE-502 unsafe deserialization (pickle.loads)
    pattern: pickle.loads(...)`,
  'os-system': `  - id: ds-os-system
    languages: [python]
    severity: ERROR
    message: CWE-78 OS command injection via os.system()
    pattern: os.system(...)`,
  'weak-hash': `  - id: ds-weak-hash
    languages: [python]
    severity: WARNING
    message: CWE-327 weak hash (md5)
    pattern: hashlib.md5(...)`,
  mktemp: `  - id: ds-mktemp
    languages: [python]
    severity: WARNING
    message: CWE-377 insecure temp file (tempfile.mktemp)
    pattern: tempfile.mktemp(...)`,
};

/** Synthesize a real Semgrep rule YAML covering the given weakness patterns. */
export function generateSemgrepRule(keys: RulePatternKey[]): string {
  const unique = [...new Set(keys)];
  return ['rules:', ...unique.map((k) => RULE_SNIPPETS[k])].join('\n') + '\n';
}

/**
 * Per-file score for a rule against a labeled corpus, judged by real Semgrep.
 * vulnerable file ⇒ 1 if detected else 0 (recall); clean/decoy file ⇒ 1 if NOT
 * detected else 0 (precision). One score per labeled file = the bootstrap sample.
 */
export function perFileScores(
  oracle: SemgrepDetectorOracle,
  ruleYaml: string,
  corpus: LabeledTarget,
): { scores: number[]; falsePositives: number; detected: string[] } {
  const findings = oracle.run(ruleYaml, corpus.dir);
  const detected = new Set(findings.map((f) => f.path));
  const scores: number[] = [];
  let falsePositives = 0;
  for (const label of corpus.labels) {
    const hit = detected.has(label.file);
    if (label.vulnerable) scores.push(hit ? 1 : 0);
    else {
      scores.push(hit ? 0 : 1);
      if (hit) falsePositives += 1;
    }
  }
  return { scores, falsePositives, detected: [...detected].sort() };
}

export interface RealCandidateGate {
  name: string;
  pass: boolean;
  detail: string;
}

export interface RealCandidateVerdict {
  available: boolean;
  promote: boolean;
  version: string;
  gates: RealCandidateGate[];
  bootstrap: BootstrapResult;
  incumbentScore: number;
  candidateScore: number;
  candidateFalsePositives: number;
  receiptHash: string;
  reason?: string;
}

const mean = (xs: number[]): number => (xs.length ? round6(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

/**
 * Judge a candidate rule against the incumbent using REAL Semgrep as the oracle
 * and the existing paired-bootstrap promotion gate. Gracefully returns
 * `available:false` when semgrep is absent (caller skips). Deterministic for a
 * fixed semgrep version + seed.
 */
export function evaluateRealCandidate(
  incumbent: RulePatternKey[],
  candidate: RulePatternKey[],
  corpus: LabeledTarget,
  opts: { oracle?: SemgrepDetectorOracle; seed?: number } = {},
): RealCandidateVerdict {
  const oracle = opts.oracle ?? new SemgrepDetectorOracle();
  const seed = opts.seed ?? 0;
  const avail = oracle.availability();
  const empty: BootstrapResult = { meanDelta: 0, lower95: 0, upper95: 0, promote: false, samples: 0, pValue: 1 };
  if (!avail.available) {
    return { available: false, promote: false, version: '', gates: [], bootstrap: empty, incumbentScore: 0, candidateScore: 0, candidateFalsePositives: 0, receiptHash: '', reason: avail.reason };
  }

  const incumbentRule = generateSemgrepRule(incumbent);
  const candidateRule = generateSemgrepRule(candidate);

  const inc = perFileScores(oracle, incumbentRule, corpus);
  const cand = perFileScores(oracle, candidateRule, corpus);
  const boot = bootstrapDelta(inc.scores, cand.scores, { seed });

  // Replay: regenerate the candidate rule + re-run; findings must be identical.
  const cand2 = perFileScores(oracle, generateSemgrepRule(candidate), corpus);
  const replayOk = JSON.stringify(cand.detected) === JSON.stringify(cand2.detected);

  const unsafe = detectUnsafe(candidateRule).length === 0;
  const noFpRegression = cand.falsePositives <= inc.falsePositives;

  const receiptHash = fnv1a(JSON.stringify({ v: avail.version, c: candidate, det: cand.detected, fp: cand.falsePositives })).toString(16).padStart(8, '0');

  const gates: RealCandidateGate[] = [
    { name: 'paired bootstrap lower95 > 0 (real semgrep)', pass: boot.lower95 > 0, detail: `lower95 ${boot.lower95}, mean ${boot.meanDelta}, p ${boot.pValue}` },
    { name: 'no false-positive regression', pass: noFpRegression, detail: `inc FP ${inc.falsePositives} → cand FP ${cand.falsePositives}` },
    { name: 'candidate carries no unsafe content', pass: unsafe, detail: 'rule YAML clean' },
    { name: 'real-oracle replay identical', pass: replayOk, detail: receiptHash },
  ];

  return {
    available: true,
    promote: gates.every((g) => g.pass),
    version: avail.version,
    gates,
    bootstrap: boot,
    incumbentScore: mean(inc.scores),
    candidateScore: mean(cand.scores),
    candidateFalsePositives: cand.falsePositives,
    receiptHash,
  };
}
