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
  /**
   * Tie-break policy when variants share the top finalScore (ADR-072's scorer
   * ceilings at 0.985, so ties are the common case). 'insertion' (default) is
   * fully reproducible — earliest insertion wins. 'faster' breaks ties by lowest
   * mean trace wall-clock, giving selection a real efficiency gradient; it is
   * NOT reproducible by construction (wall-clock), so it is strictly opt-in.
   */
  tieBreaker?: 'insertion' | 'faster';
  /**
   * Parent-selection strategy on a stalled generation (no promoted children).
   * 'score' (default) takes the top finalScore variants (ADR-073). 'quality-
   * diversity' (MAP-Elites) takes the elite per behaviour niche (mutated
   * surface) so the population keeps exploring all surfaces instead of
   * collapsing onto one at the 0.985 ceiling. Deterministic either way.
   */
  selection?: 'score' | 'quality-diversity';
  /**
   * Opt-in genetic crossover (ADR-089). When true and a generation has ≥2
   * parents, the first child of each parent recombines that parent's surfaces
   * with the next parent's (inherit a subset from each) instead of mutating.
   * Default false → mutation-only. Recombination passes the same safety gate.
   */
  crossover?: boolean;
  /**
   * Pluggable code generator (ADR-071). Default is the DeterministicMutator;
   * pass an LLM-backed one (e.g. OpenRouterMutator) to evolve via a model — it
   * still passes the same validateGeneratedCode safety gate.
   */
  generator?: import('./mutator.js').CodeGenerator;
  /**
   * Opt-in graded promotion (ADR-076). A hash-pinned benchmark suite. When set,
   * each child is evaluated against its parent over the suite in the real
   * sandbox, and the STATISTICAL promotion decision overrides the single-run
   * ADR-072 promote flag (the decision is also written to runs/<id>.bench.json).
   * Default unset → the lightweight single-run promotion is used.
   */
  benchSuite?: import('./bench/types.js').BenchSuite;
  /** Bootstrap samples for the statistical promotion gate (ADR-076). */
  benchSamples?: number;
  /** Minimum mean-delta a child must clear under the bench promotion gate. */
  benchMinDelta?: number;
  /**
   * Opt-in SGM cumulative risk budget (ADR-079). Only meaningful with benchSuite.
   * Every admitted promotion spends 1 from this shared, monotonic budget; once
   * exhausted, further promotions are refused regardless of local score — so
   * recursive self-modification cannot accumulate unbounded risk across rounds.
   * Also enforces the SOTA clauses (no hidden-test regression, cost-per-solve
   * within costCeilingFactor× the parent). Unset → no risk cap.
   */
  riskBudgetTotal?: number;
  /** Cost-per-solve ceiling as a multiple of the parent (SGM). Default 1.20. */
  costCeilingFactor?: number;
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
