// SPDX-License-Identifier: MIT
//
// Human-gated HackerOne submission (ADR-197).
//
// This module implements the FOUR human gates that MUST all pass before a real
// report is ever POSTed to a live HackerOne program. The default is ALWAYS a
// dry-run: it prints exactly what WOULD be submitted and submits nothing. A real
// POST happens only when a human runs the command with every gate satisfied and
// explicitly opts out of dry-run.
//
// SAFETY (non-negotiable):
//   - Default mode is dry-run. A real submission requires the operator to pass
//     --confirm AND --i-am-submitter AND a non-dry-run flag, with an in-scope
//     asset, a confirmed repro, and exactly one report — in an interactive (non
//     CI) environment.
//   - The human is the submitter of record. There is NO autonomous / batch path:
//     exactly one report per invocation; globs/lists/loops are refused; the real
//     (non-dry-run) path is refused when a CI / non-interactive env is detected.
//   - The scope gate FAILS CLOSED: if the program's live scope cannot be read,
//     or the asset is not an in-scope, submission-eligible asset, submission is
//     refused. Never submit without a verified scope match.
//
// The gate logic here is PURE (no network beyond the injected client) so every
// gate can be unit-tested deterministically with a mocked client + env.

import type {
  HackerOneClient,
  ProgramScopeResult,
  ScopeAsset,
  WriteScopeProbe,
  SubmitResult,
} from './hackerone.js';
import type { HackerOneReportDraft } from '../reports/hackerone.js';
import { renderHackerOneMarkdown } from '../reports/hackerone.js';

/** Per-gate verdict for a submit attempt (printed in dry-run + on refusal). */
export interface GateVerdict {
  /** Gate label. */
  gate: 'scope' | 'verification' | 'confirm' | 'no-batch' | 'write-scope';
  passed: boolean;
  /** Human-readable reason. */
  reason: string;
}

/** Inputs to the gated submit (all explicit — nothing read from globals here). */
export interface GatedSubmitInput {
  /** The single report draft to submit (exactly one). */
  draft: HackerOneReportDraft;
  /** The program handle to submit against. */
  program: string;
  /** Read-only/write HackerOne client (network injected for tests). */
  client: Pick<HackerOneClient, 'isLive' | 'programScope' | 'probeWriteScope' | 'submitReport'>;
  /** The matched in-scope asset (filled by the scope gate; do not pre-set). */
  matchedAsset?: ScopeAsset;
  /** Parsed CLI flags. */
  flags: {
    /** True unless the operator explicitly opted out of dry-run. */
    dryRun: boolean;
    /** Per-invocation explicit confirmation. */
    confirm: boolean;
    /** Operator acknowledges they are the submitter of record. */
    iAmSubmitter: boolean;
  };
  /**
   * Number of report drafts the operator's invocation referenced. MUST be 1.
   * A value !== 1 trips the no-batch gate (globs/lists/loops are refused).
   */
  reportCount: number;
  /** Environment (defaults to process.env) — used for CI / non-interactive detection. */
  env?: NodeJS.ProcessEnv;
  /** Whether stdout is a TTY (defaults to process.stdout.isTTY). Used for interactivity. */
  isTty?: boolean;
}

/** Result of a gated submit. */
export interface GatedSubmitResult {
  /** Overall: did all gates pass? */
  allGatesPassed: boolean;
  /** Per-gate verdicts (always populated, in gate order). */
  verdicts: GateVerdict[];
  /** Whether this was a dry-run (no POST attempted). */
  dryRun: boolean;
  /** The submit result when a real POST was performed (only if !dryRun + gates pass). */
  submit?: SubmitResult;
  /** The scope read (for transparency / dry-run output). */
  scope?: ProgramScopeResult;
  /** The write-scope probe (for transparency / dry-run output). */
  writeScope?: WriteScopeProbe;
  /** Human-readable lines for the CLI to print. */
  lines: string[];
}

/**
 * Detect a CI / non-interactive environment. The real (non-dry-run) submit path
 * is refused here — a human at a terminal must run it. Conservative: ANY common
 * CI signal OR a non-TTY stdout counts as non-interactive.
 */
export function isNonInteractive(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  if (!isTty) return true;
  const truthy = (v: string | undefined) =>
    v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  // Common CI markers across providers.
  const markers = [
    'CI',
    'CONTINUOUS_INTEGRATION',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'BUILDKITE',
    'CIRCLECI',
    'TRAVIS',
    'JENKINS_URL',
    'TEAMCITY_VERSION',
    'TF_BUILD',
  ];
  return markers.some((m) => truthy(env[m]));
}

/**
 * Match a draft's asset against a program's live, submission-eligible scope.
 *
 * Returns the matched ScopeAsset, or null if no in-scope, eligible asset matches
 * the draft's asset. Matching is case-insensitive on the trimmed identifier and
 * also tolerates a leading scheme (https://) so "example.com" matches a
 * "https://example.com" scope entry and vice-versa. ONLY eligible assets match.
 */
export function matchAssetInScope(
  draftAsset: string | undefined,
  assets: ScopeAsset[],
): ScopeAsset | null {
  if (!draftAsset) return null;
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
  const target = norm(draftAsset);
  if (!target) return null;
  for (const a of assets) {
    if (!a.eligibleForSubmission) continue; // fail closed: ineligible never matches
    if (norm(a.identifier) === target) return a;
  }
  return null;
}

/**
 * Run all four human gates and (only if every gate passes AND it is not a
 * dry-run) perform the real submission. Default is dry-run.
 *
 * GATES (all required to actually POST):
 *   1. SCOPE — the asset is in the program's LIVE, submission-eligible scope.
 *      FAILS CLOSED if scope is unreadable.
 *   2. VERIFICATION — draft.repro.confirmed === true (real run / PoC).
 *   3. CONFIRM — --confirm AND --i-am-submitter (human is submitter of record).
 *   4. NO BATCH / NO AUTONOMOUS — exactly one report; refuse CI/non-interactive
 *      on the real path.
 * Plus a WRITE-SCOPE check: if the token is known to lack write scope, the real
 * submit is refused with a clear message (not a crash).
 */
export async function gatedSubmit(input: GatedSubmitInput): Promise<GatedSubmitResult> {
  const env = input.env ?? process.env;
  const isTty = input.isTty ?? Boolean(process.stdout?.isTTY);
  const dryRun = input.flags.dryRun;
  const verdicts: GateVerdict[] = [];
  const lines: string[] = [];

  // ---- GATE 4 (evaluated early so batch/CI is caught before any network) ----
  const nonInteractive = isNonInteractive(env, isTty);
  let noBatchPass = true;
  let noBatchReason = 'exactly one report; interactive environment';
  if (input.reportCount !== 1) {
    noBatchPass = false;
    noBatchReason = `refused: exactly ONE report per invocation (got ${input.reportCount}). No batch/glob/list/loop submission.`;
  } else if (!dryRun && nonInteractive) {
    noBatchPass = false;
    noBatchReason = 'refused: real submission requires an interactive (non-CI) terminal. No autonomous/CI submit.';
  }
  verdicts.push({ gate: 'no-batch', passed: noBatchPass, reason: noBatchReason });

  // ---- GATE 2: VERIFICATION (AI-slop guard) ----
  const verified = input.draft.repro?.confirmed === true;
  verdicts.push({
    gate: 'verification',
    passed: verified,
    reason: verified
      ? 'repro.confirmed === true (from a real redblue run / PoC)'
      : 'refused: draft.repro.confirmed is not true — unverified / raw-model findings are not submittable.',
  });

  // ---- GATE 3: CONFIRM (human is submitter of record) ----
  const confirmed = input.flags.confirm && input.flags.iAmSubmitter;
  verdicts.push({
    gate: 'confirm',
    passed: confirmed,
    reason: confirmed
      ? '--confirm and --i-am-submitter present (human is submitter of record)'
      : 'refused: real submit requires BOTH --confirm AND --i-am-submitter on this invocation.',
  });

  // ---- GATE 1: SCOPE (read-only, FAIL CLOSED) ----
  let scope: ProgramScopeResult | undefined;
  let matched: ScopeAsset | null = null;
  let scopePass = false;
  let scopeReason: string;
  if (!input.client.isLive()) {
    scopeReason = 'refused (FAIL CLOSED): no HACKERONE_API_KEY — cannot read live program scope.';
  } else {
    scope = await input.client.programScope(input.program);
    if (!scope.readable) {
      scopeReason = `refused (FAIL CLOSED): could not read "${input.program}" live scope${scope.note ? ` (${scope.note})` : ''}. Never submitting without a verified scope match.`;
    } else if (scope.assets.length === 0) {
      scopeReason = `refused: "${input.program}" exposes no in-scope, submission-eligible assets to this token.`;
    } else {
      matched = matchAssetInScope(input.draft.asset, scope.assets);
      if (matched) {
        scopePass = true;
        scopeReason = `asset "${input.draft.asset}" matches in-scope eligible asset "${matched.identifier}" (${matched.assetType ?? 'asset'}).`;
      } else {
        scopeReason = input.draft.asset
          ? `refused: asset "${input.draft.asset}" is NOT an in-scope, submission-eligible asset for "${input.program}".`
          : 'refused: the draft carries no asset to match against the program scope.';
      }
    }
  }
  verdicts.push({ gate: 'scope', passed: scopePass, reason: scopeReason });

  const allCoreGatesPassed = noBatchPass && verified && confirmed && scopePass;

  // ---- WRITE-SCOPE probe (only matters on the real path; informational in dry-run) ----
  let writeScope: WriteScopeProbe | undefined;
  if (input.client.isLive()) {
    writeScope = await input.client.probeWriteScope();
  }

  // Build the transparency block (what WOULD be submitted) — used in dry-run AND
  // shown before any real POST so the operator sees exactly what goes out.
  lines.push(
    dryRun
      ? '# redblue hackerone submit — DRY-RUN (default). Nothing was submitted.'
      : '# redblue hackerone submit — LIVE submission requested.',
  );
  lines.push('');
  lines.push('## What WOULD be submitted');
  lines.push('');
  lines.push(`- **Program:** \`${input.program}\``);
  lines.push(
    `- **In-scope asset:** ${matched ? `\`${matched.identifier}\` (${matched.assetType ?? 'asset'})` : `\`${input.draft.asset ?? '(none)'}\` — NOT matched to live scope`}`,
  );
  lines.push(
    `- **Weakness / CWE:** ${input.draft.weakness.cwe.map((c) => `${c.id} (${c.name})`).join(', ')}`,
  );
  lines.push(
    `- **CVSS:** ${input.draft.severity.cvssRating} ${input.draft.severity.cvssBaseScore.toFixed(1)} (\`${input.draft.severity.cvssVector}\`)`,
  );
  lines.push(`- **HackerOne severity:** ${input.draft.severity.hackeroneSeverity}`);
  lines.push(`- **Repro confirmed:** ${verified ? 'yes' : 'NO'}`);
  lines.push('');
  lines.push('### Report body (redacted)');
  lines.push('');
  lines.push('```markdown');
  lines.push(renderHackerOneMarkdown(input.draft));
  lines.push('```');
  lines.push('');
  lines.push('## Gates');
  lines.push('');
  for (const v of verdicts) {
    lines.push(`- ${v.passed ? 'PASS' : 'FAIL'} — **${v.gate}**: ${v.reason}`);
  }
  if (writeScope) {
    lines.push(
      `- INFO — **write-scope**: ${writeScope.status}${writeScope.note ? ` (${writeScope.note})` : ''}`,
    );
  }
  lines.push('');

  // ---- DRY-RUN: stop here, submit nothing. ----
  if (dryRun) {
    lines.push(
      allCoreGatesPassed
        ? '> All gates pass. This was a DRY-RUN — re-run with `--no-dry-run --confirm --i-am-submitter` (in an interactive terminal) to submit for real.'
        : '> One or more gates failed (see above). Nothing was submitted.',
    );
    return {
      allGatesPassed: allCoreGatesPassed,
      verdicts,
      dryRun: true,
      scope,
      writeScope,
      lines,
    };
  }

  // ---- REAL PATH: every gate must pass. ----
  if (!allCoreGatesPassed) {
    lines.push('> Refusing to submit: one or more gates failed. Nothing was submitted.');
    return { allGatesPassed: false, verdicts, dryRun: false, scope, writeScope, lines };
  }

  // Write-scope must not be known-absent (fail closed with a clear message).
  if (writeScope && writeScope.status === 'absent') {
    lines.push(
      `> Refusing to submit: this token lacks report-write scope (${writeScope.note ?? 'write denied'}). ` +
        'Provision a token with report-creation permission, or submit manually in HackerOne. Nothing was submitted.',
    );
    return { allGatesPassed: true, verdicts, dryRun: false, scope, writeScope, lines };
  }

  // Perform the single, fully-authorized POST.
  const submit = await input.client.submitReport({
    teamHandle: input.program,
    title: input.draft.title,
    vulnerabilityInformation: renderHackerOneMarkdown(input.draft),
    severityRating: input.draft.severity.hackeroneSeverity,
    structuredScopeId: undefined, // matched by asset; H1 derives scope from team + asset.
  });
  if (submit.ok) {
    lines.push(`> Submitted. HackerOne report id: ${submit.reportId}. You are the submitter of record.`);
  } else {
    lines.push(
      `> Submission failed (HTTP ${submit.status})${submit.note ? `: ${submit.note}` : ''}. No partial report was created.`,
    );
  }
  return { allGatesPassed: true, verdicts, dryRun: false, submit, scope, writeScope, lines };
}
