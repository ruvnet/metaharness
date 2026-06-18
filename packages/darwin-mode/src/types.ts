// SPDX-License-Identifier: MIT
//
// Darwin Mode — shared types (the integration contract).
//
// Every module in this package codes against these interfaces. They are the
// load-bearing contract: the profiler produces a RepoProfile; the generator and
// mutator produce HarnessVariants; the sandbox produces RunTraces; the scorer
// folds traces into a ScoreCard; the archive stores ArchiveRecords as a tree.
//
// See ADR-070 (loop), ADR-071 (mutation surfaces), ADR-072 (scoring),
// ADR-073 (archive), ADR-075 (acceptance).

/**
 * The seven — and only seven — files a child variant may mutate (ADR-071). One
 * concern each. The authoritative filename mapping lives in `safety.ts`
 * (`FILE_BY_SURFACE` / `APPROVED_FILES`); this union is the symbolic handle.
 */
export type MutationSurface =
  | 'planner'
  | 'contextBuilder'
  | 'reviewer'
  | 'retryPolicy'
  | 'toolPolicy'
  | 'memoryPolicy'
  | 'scorePolicy';

/** A repo distilled to the signals Darwin Mode needs (ADR-070 §profile). */
export interface RepoProfile {
  /** Absolute path to the repo root. */
  root: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'unknown';
  /** The command the sandbox runs to score a variant, e.g. "npm test". */
  testCommand: string;
  /** Source files discovered (relative to root), used by the context builder. */
  sourceFiles: string[];
  /** Files matching risk patterns (.env / secret / deploy / …) — never written. */
  riskFiles: string[];
  /** A short, human-readable one-line summary. */
  summary: string;
}

/** A single harness variant: a directory of approved mutation-surface files. */
export interface HarnessVariant {
  /** Stable id; "baseline" for the root, else `g<gen>_v<index>_<rand>`. */
  id: string;
  /** Parent variant id, or null for the baseline. */
  parentId: string | null;
  /** Generation number (0 = baseline). */
  generation: number;
  /** Absolute path to this variant's directory under workRoot/variants. */
  dir: string;
  /** Which surface this variant mutated relative to its parent. */
  mutationSurface: MutationSurface;
  /** One-line description of the mutation. */
  mutationSummary: string;
  /** ISO timestamp of creation. */
  createdAt: string;
}

/** The result of running one variant against one task in the sandbox. */
export interface RunTrace {
  variantId: string;
  taskId: string;
  startedAt: string;
  finishedAt: string;
  /** Process exit code. The reserved value 99 means "disqualified by safety". */
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Whether the run hit its wall-clock timeout (drives the tool-loop penalty). */
  timedOut: boolean;
  /** Findings from the pre-execution safety inspection (empty ⇒ clean). */
  blockedActions: string[];
}

/** A fully-scored variant (ADR-072). All terms and penalties are in [0,1]. */
export interface ScoreCard {
  variantId: string;
  // --- positive weighted terms ---
  taskSuccess: number;
  testPassRate: number;
  traceQuality: number;
  costEfficiency: number;
  latencyEfficiency: number;
  safetyScore: number;
  // --- hard penalties ---
  secretExposure: number;
  destructiveAction: number;
  hallucinatedFile: number;
  toolLoop: number;
  costOverrun: number;
  // --- result ---
  /** Weighted base score before penalties (0..1). */
  baseScore: number;
  /** baseScore minus the penalty layer (may be negative). */
  finalScore: number;
  /** True iff the strict promotion gate (ADR-072) holds vs. the parent. */
  promoted: boolean;
  reason: string;
}

/** One node in the archive tree (ADR-073). */
export interface ArchiveRecord {
  variant: HarnessVariant;
  /** null until evaluated. */
  score: ScoreCard | null;
  /** Child variant ids (the tree edges). */
  children: string[];
}

/** Configuration for a full `evolve` run. */
export interface EvolutionConfig {
  /** Absolute path to the repo to evolve. */
  repoRoot: string;
  /** Absolute path to the `.metaharness` work tree. */
  workRoot: string;
  /** Number of generations to run. */
  generations: number;
  /** Children produced per parent per generation. */
  childrenPerGeneration: number;
  /** The fixed task ids each variant is scored on (the child cannot edit these). */
  tasks: string[];
  /** A child must beat its parent's finalScore by at least this margin (ADR-072). */
  promotionDelta: number;
  /** Max variants evaluated concurrently (bounded resource use). Default 4. */
  concurrency?: number;
  /** Per-variant test-command wall-clock budget in ms. Default 120000. */
  taskTimeoutMs?: number;
  /** Per-generation cost-proxy budget (cumulative variant-seconds). Optional breaker. */
  costBudgetSeconds?: number;
  /** Deterministic seed for mutation selection (reproducibility). Default 0. */
  seed?: number;
}

/** The outcome of an `evolve` run. */
export interface EvolutionResult {
  baseline: ArchiveRecord;
  winner: ArchiveRecord | null;
  /** Every record in the archive, in insertion order. */
  records: ArchiveRecord[];
  generations: number;
  /** Lineage of the winner, baseline → … → winner (ids). */
  winnerLineage: string[];
}
