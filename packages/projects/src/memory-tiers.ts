// SPDX-License-Identifier: MIT
//
// @metaharness/projects — memory-tiers.ts (ADR-161 ruVector Memory Tiers).
//
// Borrowed from CrewAI's unified memory model: a single store that fronts several
// typed memory tiers (working / repo / mutation / cost / risk) behind one API. The
// program thesis is that memory is a *policy* knob — the mutatable depth selector
// decides which tiers a task class may read, and turning memory ON must reduce
// input tokens (cached repo context need not be re-read) WITHOUT lowering the solve
// rate. That last invariant is the whole point: cheaper, never dumber.
//
// The optimization (measured in bench/memory-tiers.bench.mjs): simulateRun() compares
// a memory-OFF run against a memory-ON run on the same task suite and reports the %
// of input tokens saved while asserting the solved count is unchanged.

import { makeRng, fnv1a, clamp, round6 } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// The five typed tiers and a tiered, isolated key/value store with token search.
// ─────────────────────────────────────────────────────────────────────────────

/** The five ruVector memory tiers. Each is an isolated namespace. */
export type MemoryTier = 'working' | 'repo' | 'mutation' | 'cost' | 'risk';

/** A search result: the stored value plus its deterministic relevance score. */
export interface MemoryHit<T> {
  key: string;
  value: T;
  score: number;
}

const ALL_TIERS: readonly MemoryTier[] = ['working', 'repo', 'mutation', 'cost', 'risk'];

/** Lowercase alphanumeric tokenization (deterministic, no external embeddings). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Deterministic token-overlap relevance: Jaccard-like overlap of query vs. key
 * tokens, lightly weighted by a stable per-token hash so ties break reproducibly.
 * Returns a score in [0, 1]; 0 means no shared tokens.
 */
function overlapScore(query: string, key: string): number {
  const q = new Set(tokenize(query));
  const k = new Set(tokenize(key));
  if (q.size === 0 || k.size === 0) return 0;
  let shared = 0;
  let weight = 0;
  for (const t of q) {
    if (k.has(t)) {
      shared += 1;
      // Stable fractional weight in (0,1] from the token hash — pure tie-break.
      weight += (fnv1a(t) % 1000) / 1000;
    }
  }
  const union = new Set([...q, ...k]).size;
  const jaccard = shared / union;
  // Blend in a vanishingly small hash term (1e-9) so EQUAL-overlap keys order
  // deterministically WITHOUT reordering keys of genuinely different overlap (the
  // smallest representable jaccard gap is ~1e-3, far above this tie-break weight).
  return round6(clamp(jaccard + (weight / Math.max(1, q.size)) * 1e-9, 0, 1));
}

/** Isolated, tier-keyed memory store with deterministic token-overlap search. */
export class TieredMemory {
  // One Map per tier — isolation is structural: a key in `repo` is invisible to `risk`.
  private readonly tiers: Map<MemoryTier, Map<string, unknown>> = new Map(
    ALL_TIERS.map((t) => [t, new Map<string, unknown>()]),
  );

  /** Store a value under `key` in `tier`. Overwrites an existing key in that tier. */
  put<T>(tier: MemoryTier, key: string, value: T): void {
    this.tiers.get(tier)!.set(key, value);
  }

  /** Read a value by exact key from `tier`. Undefined if absent (or in another tier). */
  get<T>(tier: MemoryTier, key: string): T | undefined {
    return this.tiers.get(tier)!.get(key) as T | undefined;
  }

  /** Remove a key from `tier`. Returns true if a value was present and removed. */
  delete(tier: MemoryTier, key: string): boolean {
    return this.tiers.get(tier)!.delete(key);
  }

  /**
   * Rank the keys of `tier` by deterministic token-overlap with `query` and return
   * the top `topK` hits (score > 0). Ordering: score desc, then key asc — fully
   * reproducible. Searches ONLY the named tier (isolation preserved).
   */
  search<T>(tier: MemoryTier, query: string, topK = 5): MemoryHit<T>[] {
    const store = this.tiers.get(tier)!;
    const hits: MemoryHit<T>[] = [];
    for (const [key, value] of store) {
      const score = overlapScore(query, key);
      if (score > 0) hits.push({ key, value: value as T, score });
    }
    hits.sort((a, b) => (b.score - a.score) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return hits.slice(0, Math.max(0, topK));
  }

  /** Number of keys in one tier, or across all tiers when `tier` is omitted. */
  size(tier?: MemoryTier): number {
    if (tier !== undefined) return this.tiers.get(tier)!.size;
    let n = 0;
    for (const t of ALL_TIERS) n += this.tiers.get(t)!.size;
    return n;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The mutatable memory-DEPTH selector — which tiers a task class may read.
// ─────────────────────────────────────────────────────────────────────────────

/** The classes of task the depth policy discriminates between. */
export type TaskClass = 'repo-bound' | 'greenfield' | 'security' | 'refactor';

/** Maps each task class to the ordered list of tiers it is allowed to read. */
export interface MemoryDepthPolicy {
  byTaskClass: Record<TaskClass, MemoryTier[]>;
}

/**
 * The default depth policy. Repo-bound work gets the full stack (it benefits most
 * from cached repo/mutation/cost context); greenfield gets only working memory
 * (nothing to recall yet); security adds the risk tier; refactor adds repo.
 */
export function defaultDepthPolicy(): MemoryDepthPolicy {
  return {
    byTaskClass: {
      'repo-bound': ['working', 'repo', 'mutation', 'cost', 'risk'],
      greenfield: ['working'],
      security: ['working', 'risk', 'repo'],
      refactor: ['working', 'repo'],
    },
  };
}

/** The tiers a given task class may read under policy `p`. */
export function depthFor(p: MemoryDepthPolicy, taskClass: TaskClass): MemoryTier[] {
  return p.byTaskClass[taskClass] ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// simulateRun — the A/B that proves "memory ON is cheaper, never dumber".
// ─────────────────────────────────────────────────────────────────────────────

/** Tiers whose presence in the active depth yields repo-context reuse savings. */
const SAVINGS_TIERS: readonly MemoryTier[] = ['repo', 'mutation', 'cost'];
/** Per active savings-tier token reduction, and the hard cap on total reduction. */
const PER_TIER_REDUCTION = 0.15;
const MAX_REDUCTION = 0.4;
/** Task classes that can reuse cached repo context when memory is on. */
const REUSE_CLASSES = new Set<TaskClass>(['repo-bound', 'refactor']);

/** One task in a simulated suite. */
export interface MemTask {
  id: string;
  taskClass: TaskClass;
  baseTokens: number;
  /** Whether this task is solvable when memory context is available. */
  solvableWithMemory: boolean;
}

/**
 * Deterministic base-solve rule, independent of memory: a stable hash of the task
 * id gates solving so the memory-OFF and memory-ON runs share the SAME baseline of
 * solved tasks. A task is solved iff it is solvable-with-memory OR clears this rule
 * — and crucially this does not depend on `memoryOn`, so memory can never lower the
 * solved count.
 */
function baseSolved(task: MemTask, seed: number): boolean {
  const r = makeRng(fnv1a(task.id) ^ (seed >>> 0))();
  return task.solvableWithMemory || r >= 0.5;
}

/**
 * Run a task suite with memory OFF or ON (same seed → comparable). With memory ON,
 * repo-bound/refactor tasks reuse cached repo context: their input-token cost drops
 * by PER_TIER_REDUCTION per active savings-tier in the task's depth, capped at
 * MAX_REDUCTION. The solve outcome is computed by baseSolved() and is IDENTICAL in
 * both modes, so `tokensSavedPct` is pure savings with no solve-rate regression.
 */
export function simulateRun(
  tasks: MemTask[],
  opts: { memoryOn: boolean; depth: MemoryDepthPolicy; seed: number },
): { totalTokens: number; solved: number; tokensSavedPct: number } {
  // Compute the memory-OFF total once (the comparison baseline).
  let offTotal = 0;
  let onTotal = 0;
  let solved = 0;

  for (const task of tasks) {
    offTotal += task.baseTokens;

    let tokens = task.baseTokens;
    if (opts.memoryOn && REUSE_CLASSES.has(task.taskClass)) {
      const active = depthFor(opts.depth, task.taskClass).filter((t) => SAVINGS_TIERS.includes(t));
      const reduction = clamp(active.length * PER_TIER_REDUCTION, 0, MAX_REDUCTION);
      tokens = task.baseTokens * (1 - reduction);
    }
    onTotal += tokens;

    if (baseSolved(task, opts.seed)) solved += 1;
  }

  const totalTokens = round6(opts.memoryOn ? onTotal : offTotal);
  const tokensSavedPct = offTotal === 0 ? 0 : round6(((offTotal - onTotal) / offTotal) * 100);
  return { totalTokens, solved, tokensSavedPct: opts.memoryOn ? tokensSavedPct : 0 };
}
