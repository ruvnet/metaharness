// SPDX-License-Identifier: MIT
//
// Mutation-surface templates (ADR-071) — seven pure functions, one per surface,
// each returning the SOURCE TEXT of a baseline mutation-surface file.
//
// LOAD-BEARING CONSTRAINT: every string returned here is later written to a
// variant directory and statically scanned by `inspectVariant` /
// `validateGeneratedCode`. The emitted source therefore contains ONLY pure,
// side-effect-free policy logic that operates on its arguments — no process,
// network, filesystem, dynamic-eval, shell, or sensitive-material references.
// The policies are expressed over symbolic data injected at call time, never
// over embedded literals.

import type { RepoProfile } from './types.js';

/**
 * planner.ts — turns a task string into an ordered list of plan steps. The
 * baseline plan is a generic map → inspect → patch → verify loop, with the
 * repository summary baked in as data for downstream context.
 */
export function plannerTemplate(profile: RepoProfile): string {
  return `// SPDX-License-Identifier: MIT
//
// planner — mutation surface "planner" (ADR-071). Pure policy: task -> steps.

/** One ordered step in a plan. */
export interface PlanStep {
  /** Stable ordering index, 0-based. */
  order: number;
  /** Short symbolic kind of work this step performs. */
  kind: 'map' | 'inspect' | 'patch' | 'verify';
  /** Human-readable description of the step. */
  description: string;
}

/** A one-line summary of the repository this harness was generated for. */
export const repoSummary = ${JSON.stringify(profile.summary)};

/**
 * Build an ordered plan for a task. The baseline strategy is deliberately
 * conservative: locate the relevant files, inspect the existing tests, apply a
 * minimal patch, then verify by running the test command.
 */
export function createPlan(task: string): PlanStep[] {
  const trimmed = task.trim();
  const label = trimmed.length > 0 ? trimmed : 'the requested change';
  return [
    { order: 0, kind: 'map', description: \`Map files relevant to: \${label}\` },
    { order: 1, kind: 'inspect', description: 'Inspect existing tests and surrounding code' },
    { order: 2, kind: 'patch', description: 'Apply the smallest patch that satisfies the task' },
    { order: 3, kind: 'verify', description: 'Verify by running the project test command' },
  ];
}
`;
}

/**
 * context_builder.ts — ranks candidate files by lexical overlap with the task
 * terms and returns the top slice as context items.
 */
export function contextBuilderTemplate(): string {
  return `// SPDX-License-Identifier: MIT
//
// context builder — mutation surface "contextBuilder" (ADR-071). Pure policy:
// rank candidate files by overlap with the task's terms.

/** A ranked piece of context offered to the worker. */
export interface ContextItem {
  /** Relative path of the file. */
  path: string;
  /** Overlap score (count of shared terms). Higher is more relevant. */
  score: number;
}

/** Split a string into lowercased alphanumeric terms of length >= 2. */
function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Rank \`files\` by how many task terms appear in each file path, returning the
 * top 30 items in descending relevance. Ties keep the original path order.
 */
export function buildContext(task: string, files: string[]): ContextItem[] {
  const wanted = new Set(terms(task));
  const scored = files.map((path, index) => {
    const pathTerms = terms(path);
    let score = 0;
    for (const t of pathTerms) if (wanted.has(t)) score += 1;
    return { path, score, index };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.slice(0, 30).map(({ path, score }) => ({ path, score }));
}
`;
}

/**
 * reviewer.ts — flags changed files that intersect an injected risk-file list
 * and escalates severity when tests have failed. No inline pattern matching on
 * sensitive words; the risk set is passed in as data.
 */
export function reviewerTemplate(): string {
  return `// SPDX-License-Identifier: MIT
//
// reviewer — mutation surface "reviewer" (ADR-071). Pure policy: judge a patch
// against an injected risk-file list and the test outcome.

/** A single review finding for one changed file. */
export interface ReviewFinding {
  /** The changed file the finding refers to. */
  file: string;
  /** Severity of the finding. */
  severity: 'blocker' | 'warning' | 'info';
  /** Why the finding was raised. */
  reason: string;
}

/**
 * Review a patch. A changed file is flagged when it appears in the injected
 * \`riskFiles\` list (the reviewer does not itself decide what is risky — that
 * judgement is supplied as data). When the test suite failed, findings are
 * escalated to 'blocker'; otherwise risk-file edits are 'warning' and all other
 * changes are 'info'.
 */
export function reviewPatch(
  changedFiles: string[],
  testPassed: boolean,
  riskFiles: string[],
): ReviewFinding[] {
  const risky = new Set(riskFiles);
  const findings: ReviewFinding[] = [];
  for (const file of changedFiles) {
    const isRisky = risky.has(file);
    if (!testPassed) {
      findings.push({
        file,
        severity: 'blocker',
        reason: isRisky
          ? 'tests failed and the change touches a protected file'
          : 'tests failed for this change',
      });
    } else if (isRisky) {
      findings.push({
        file,
        severity: 'warning',
        reason: 'change touches a protected file',
      });
    } else {
      findings.push({ file, severity: 'info', reason: 'routine change' });
    }
  }
  return findings;
}
`;
}

/**
 * retry_policy.ts — decides whether to retry an attempt based on a symbolic
 * failure classification (an injected enum), never by scanning raw output.
 */
export function retryPolicyTemplate(): string {
  return `// SPDX-License-Identifier: MIT
//
// retry policy — mutation surface "retryPolicy" (ADR-071). Pure policy: decide
// whether to retry based on an injected, symbolic failure classification.

/** Symbolic classification of a failed attempt, supplied by the caller. */
export type FailureClassification = 'transient' | 'repairable' | 'unknown';

/** The decision about whether and how to retry. */
export interface RetryDecision {
  /** Whether another attempt should be made. */
  retry: boolean;
  /** Backoff to wait before the next attempt, in milliseconds. */
  backoffMs: number;
  /** Why the decision was made. */
  reason: string;
}

/** Maximum number of attempts the baseline policy will allow. */
export const maxAttempts = 3;

/**
 * Decide whether to retry. Transient failures (e.g. a timeout) are retried with
 * exponential backoff; repairable failures (e.g. a type error a patch can fix)
 * get one immediate retry; unknown failures are not retried. The classification
 * is injected — the policy never inspects raw process output.
 */
export function decideRetry(
  attempt: number,
  classification: FailureClassification,
): RetryDecision {
  if (attempt >= maxAttempts) {
    return { retry: false, backoffMs: 0, reason: 'attempt budget exhausted' };
  }
  switch (classification) {
    case 'transient':
      return {
        retry: true,
        backoffMs: 250 * 2 ** attempt,
        reason: 'transient failure — retry with backoff',
      };
    case 'repairable':
      return { retry: true, backoffMs: 0, reason: 'repairable failure — retry once' };
    case 'unknown':
    default:
      return { retry: false, backoffMs: 0, reason: 'unknown failure — do not retry' };
  }
}
`;
}

/**
 * tool_policy.ts — expresses the tool policy over symbolic command kinds, with
 * an allow-list and a deterministic ordering. No raw shell strings appear.
 */
export function toolPolicyTemplate(): string {
  return `// SPDX-License-Identifier: MIT
//
// tool policy — mutation surface "toolPolicy" (ADR-071). Pure policy over
// SYMBOLIC command kinds. No raw shell strings are embedded.

/** The symbolic kinds of command the harness may schedule. */
export type CommandKind = 'test' | 'build' | 'lint';

/** The allow-listed kinds, in canonical order. */
export const allowedKinds: CommandKind[] = ['test', 'build', 'lint'];

/** True iff the given kind is permitted. */
export function isKindAllowed(k: CommandKind): boolean {
  return allowedKinds.includes(k);
}

/** Preferred execution order: lint first (cheap), then build, then test. */
const ORDER: Record<CommandKind, number> = { lint: 0, build: 1, test: 2 };

/**
 * Order a set of requested kinds deterministically (cheapest-first), dropping
 * any kind that is not allow-listed.
 */
export function orderKinds(kinds: CommandKind[]): CommandKind[] {
  return kinds
    .filter(isKindAllowed)
    .slice()
    .sort((a, b) => ORDER[a] - ORDER[b]);
}
`;
}

/**
 * memory_policy.ts — decides whether an outcome record is worth remembering.
 */
export function memoryPolicyTemplate(): string {
  return `// SPDX-License-Identifier: MIT
//
// memory policy — mutation surface "memoryPolicy" (ADR-071). Pure policy:
// decide whether an outcome record is worth keeping.

/** A record of one outcome the harness might choose to remember. */
export interface MemoryRecord {
  /** Whether the associated task ultimately succeeded. */
  success: boolean;
  /** How many attempts the task took. */
  attempts: number;
  /** Whether this outcome was novel relative to what is already known. */
  novel: boolean;
}

/**
 * Decide whether to remember a record. The baseline keeps anything novel, plus
 * any failure that took more than one attempt (a hard case worth recalling).
 */
export function shouldRemember(record: MemoryRecord): boolean {
  if (record.novel) return true;
  if (!record.success && record.attempts > 1) return true;
  return false;
}
`;
}

/**
 * score_policy.ts — the weight vector folded over the positive scoring terms.
 */
export function scorePolicyTemplate(): string {
  return `// SPDX-License-Identifier: MIT
//
// score policy — mutation surface "scorePolicy" (ADR-071). Pure policy: the
// weight vector applied to the positive scoring terms (ADR-072). Weights are
// non-negative and sum to 1.

/** The weights applied to each positive scoring term. */
export interface ScoreWeights {
  taskSuccess: number;
  testPassRate: number;
  traceQuality: number;
  costEfficiency: number;
  latencyEfficiency: number;
  safetyScore: number;
}

/** The baseline weight vector (sums to 1). */
export function scoreWeights(): ScoreWeights {
  return {
    taskSuccess: 0.35,
    testPassRate: 0.2,
    traceQuality: 0.15,
    costEfficiency: 0.1,
    latencyEfficiency: 0.1,
    safetyScore: 0.1,
  };
}
`;
}
