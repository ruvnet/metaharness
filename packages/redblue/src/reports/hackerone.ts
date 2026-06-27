// SPDX-License-Identifier: MIT
//
// HackerOne report export — DRAFT / DRY-RUN ONLY.
//
// Turns a redblue finding (a compromised TestResult, optionally with its
// originating TestCase) into a bounty-report-ready DRAFT: an industry-standard
// structured payload (title, weakness/CWE, severity/CVSS vector, redacted
// evidence, repro steps from the SAFE taxonomy, impact) plus a markdown render.
//
// SAFETY (non-negotiable):
//   - This module NEVER submits anything to a live HackerOne program. It builds
//     a draft object only. The structured payload includes `draft: true` and a
//     `submission: { auto_submit: false }` marker so it is unambiguous.
//   - All evidence is passed through redblue's existing redact() before it ever
//     enters a draft.
//   - Repro steps are derived from the family's SAFE objective/expected-behavior
//     taxonomy — never a working exploit string.

import type { AttackFamily, SeverityBand, TestCase, TestResult } from '../types.js';
import { redact, redactAll } from '../config/safety.js';
import {
  cvssForBand,
  taxonomyForFamily,
  type CweRef,
} from '../integrations/cwe-cvss.js';

/** The structured, submittable-shaped HackerOne report DRAFT. */
export interface HackerOneReportDraft {
  /** Always true — this is a draft, never an auto-submission. */
  draft: true;
  title: string;
  /** redblue family + standard taxonomy. */
  weakness: {
    family: AttackFamily;
    cwe: CweRef[];
    owaspLlm: string;
  };
  severity: {
    /** redblue's own 0..1 score + band (preserved verbatim, honest). */
    redblueBand: SeverityBand;
    redblueScore: number;
    /** Mapped CVSS 3.1. */
    cvssVector: string;
    cvssBaseScore: number;
    cvssRating: 'None' | 'Low' | 'Medium' | 'High' | 'Critical';
    /** HackerOne severity rating field value. */
    hackeroneSeverity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  };
  impact: string;
  /** Numbered repro steps, derived from the SAFE family taxonomy. */
  stepsToReproduce: string[];
  /** Redacted evidence strings (redact() applied). */
  evidence: string[];
  recommendedFix?: string;
  /**
   * The asset the finding is against — matched against the program's LIVE
   * in-scope assets by the scope gate before any submission. A draft WITHOUT an
   * asset can never pass the scope gate (it cannot be matched to live scope).
   */
  asset?: string;
  /**
   * Reproduction provenance. The verification gate requires `confirmed === true`
   * (a real redblue run / PoC produced this finding) before a submit is allowed.
   * Unverified / raw-model drafts have `confirmed: false` and are refused
   * (AI-slop guard). `confirmed` defaults to false unless the producing run sets
   * it, so a hand-built or model-generated draft cannot accidentally qualify.
   */
  repro: {
    confirmed: boolean;
    /** Optional human note on how the repro was confirmed. */
    method?: string;
  };
  /** Explicit, machine-readable safety marker. */
  submission: {
    auto_submit: false;
    note: string;
  };
}

export interface ToHackerOneReportOptions {
  /** The originating test case (for the safe probe + expected behavior). */
  testCase?: TestCase;
  /** Override the program handle for the draft (informational only). */
  program?: string;
  /**
   * The asset this finding is against (used by the scope gate to verify it is in
   * the program's live scope). Drafts produced by a redblue run should carry the
   * target asset; without it, the scope gate cannot match and submission fails.
   */
  asset?: string;
  /**
   * Mark the repro as confirmed. The verification gate requires this to be true
   * before a submit. It MUST come from a real redblue run / PoC — defaults to
   * false so a hand-built or raw-model draft cannot pass the gate by omission.
   */
  reproConfirmed?: boolean;
  /** Optional note describing how the repro was confirmed. */
  reproMethod?: string;
}

/**
 * Build a HackerOne report DRAFT from a single finding.
 *
 * Evidence is redacted here (defense in depth) even though the runner already
 * redacts — so a finding constructed by hand or from an older run is still safe.
 */
export function toHackerOneReport(
  result: TestResult,
  options: ToHackerOneReportOptions = {},
): HackerOneReportDraft {
  const tax = taxonomyForFamily(result.family);
  const cvss = cvssForBand(result.severity);
  const tc = options.testCase;

  const title = redact(
    `[${tax.cwe[0].id}] ${humanizeFamily(result.family)} in agent target (${result.testId})`,
  );

  // Repro steps come from the SAFE taxonomy: the adversarial objective, the
  // benign probe, the expected-safe behavior, and the observed compromise.
  // No working exploit — just the shape a triager needs to reproduce.
  const steps: string[] = [];
  if (tc) {
    steps.push(`Adversarial objective: ${redact(tc.objective)}`);
    steps.push(`Send the target a benign-looking probe of this class: ${redact(tc.input)}`);
    steps.push(`Expected safe behavior: ${redact(tc.expectedSafeBehavior)}`);
    steps.push(
      `Observed: the target exhibited a forbidden outcome — ${redactAll(tc.forbiddenOutcomes).join('; ')}.`,
    );
  } else {
    steps.push(`Adversarial objective: ${tax.impact}`);
    steps.push(
      `Exercise the "${result.family}" attack family against the target (see @metaharness/redblue safe taxonomy).`,
    );
    steps.push('Observe the target perform a forbidden outcome for this family.');
  }
  steps.push(
    `redblue judged this finding ${result.severity} (score ${result.severityScore.toFixed(3)}).`,
  );

  return {
    draft: true,
    title,
    weakness: {
      family: result.family,
      cwe: tax.cwe,
      owaspLlm: tax.owaspLlm,
    },
    severity: {
      redblueBand: result.severity,
      redblueScore: result.severityScore,
      cvssVector: tax.cvssVector,
      cvssBaseScore: cvss.baseScore,
      cvssRating: cvss.rating,
      hackeroneSeverity: cvss.hackeroneSeverity,
    },
    impact: tax.impact,
    stepsToReproduce: steps,
    evidence: redactAll(result.evidence),
    recommendedFix: result.recommendedFix ? redact(result.recommendedFix) : undefined,
    asset: options.asset ? redact(options.asset) : undefined,
    repro: {
      // A finding came from a real redblue run when its result is `compromised`
      // (the judge confirmed the forbidden outcome) — but the verification gate
      // only trusts an EXPLICIT confirmation. Default false unless set; a real
      // run sets reproConfirmed:true. Never auto-true from a hand-built result.
      confirmed: options.reproConfirmed === true,
      method: options.reproMethod,
    },
    submission: {
      auto_submit: false,
      note:
        'DRAFT ONLY — generated by @metaharness/redblue. This is a dry-run payload; ' +
        'it was NOT submitted to any HackerOne program. Review, then submit manually if appropriate.',
    },
  };
}

/** Render a HackerOne draft as a bounty-report markdown body. */
export function renderHackerOneMarkdown(draft: HackerOneReportDraft): string {
  const lines: string[] = [];
  lines.push(`# ${draft.title}`);
  lines.push('');
  lines.push('> **DRAFT — NOT SUBMITTED.** Generated by `@metaharness/redblue`. Review before any manual submission.');
  lines.push('');
  lines.push('## Weakness');
  lines.push('');
  lines.push(`- **Family:** \`${draft.weakness.family}\``);
  lines.push(`- **CWE:** ${draft.weakness.cwe.map((c) => `${c.id} (${c.name})`).join(', ')}`);
  lines.push(`- **OWASP LLM:** ${draft.weakness.owaspLlm}`);
  lines.push('');
  lines.push('## Severity');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| redblue band | ${draft.severity.redblueBand} (${draft.severity.redblueScore.toFixed(3)}) |`);
  lines.push(`| CVSS 3.1 | ${draft.severity.cvssRating} ${draft.severity.cvssBaseScore.toFixed(1)} |`);
  lines.push(`| CVSS vector | \`${draft.severity.cvssVector}\` |`);
  lines.push(`| HackerOne severity | ${draft.severity.hackeroneSeverity} |`);
  lines.push('');
  if (draft.asset) {
    lines.push('## Asset');
    lines.push('');
    lines.push(`- **Asset:** \`${draft.asset}\``);
    lines.push(`- **Repro confirmed:** ${draft.repro.confirmed ? 'yes' : 'no'}${draft.repro.method ? ` (${draft.repro.method})` : ''}`);
    lines.push('');
  }
  lines.push('## Impact');
  lines.push('');
  lines.push(draft.impact);
  lines.push('');
  lines.push('## Steps to Reproduce');
  lines.push('');
  draft.stepsToReproduce.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push('');
  if (draft.evidence.length) {
    lines.push('## Evidence (redacted)');
    lines.push('');
    for (const e of draft.evidence) lines.push(`- ${e}`);
    lines.push('');
  }
  if (draft.recommendedFix) {
    lines.push('## Recommended Fix');
    lines.push('');
    lines.push(draft.recommendedFix);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push(`_${draft.submission.note}_`);
  return lines.join('\n');
}

/**
 * Build drafts for every compromised finding in a result set.
 *
 * These drafts come from a REAL redblue run: each `compromised` result was
 * adjudicated by the judge against the safe taxonomy, so they are marked
 * `repro.confirmed: true` (the verification gate trusts a real run, not a
 * hand-built or raw-model draft). `asset` can be threaded through `opts.asset`
 * (e.g. the configured target) so the scope gate can match against live scope.
 */
export function toHackerOneReports(
  results: TestResult[],
  testCases?: TestCase[],
  opts: { asset?: string } = {},
): HackerOneReportDraft[] {
  const byId = new Map<string, TestCase>();
  if (testCases) for (const tc of testCases) byId.set(tc.id, tc);
  return results
    .filter((r) => r.compromised)
    .map((r) =>
      toHackerOneReport(r, {
        testCase: byId.get(r.testId),
        asset: opts.asset,
        reproConfirmed: true,
        reproMethod: 'redblue baseline run (judge-adjudicated forbidden outcome)',
      }),
    );
}

function humanizeFamily(family: AttackFamily): string {
  return family
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
