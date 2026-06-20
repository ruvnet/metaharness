// SPDX-License-Identifier: MIT
//
// @metaharness/projects — checkpoints.ts (ADR-157 Darwin Checkpoints).
//
// Durable, resumable runs borrowed from LangGraph's durable execution model. A
// run is a sequence of RunSteps; after each step we persist a Checkpoint to a
// CheckpointStore. A killed run resumes from the SAME store WITHOUT re-issuing
// the expensive model calls of already-checkpointed steps, and the final result
// is byte-for-byte identical to an uninterrupted run (deterministic replay).
//
// The optimization (measured in bench/checkpoints.bench.mjs): resuming reuses
// persisted step results + a content-addressed CallCache, so cost-units already
// paid before the crash are NOT paid again. Reliability after resume is 100%.

import type { PolicyObject } from './core.js';
import { hashJson } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// Checkpoint shape + durable store.
// ─────────────────────────────────────────────────────────────────────────────

/** One persisted step boundary. `hash` is the deterministic replay fingerprint. */
export interface Checkpoint {
  runId: string;
  step: number;
  genomeId: string;
  state: unknown;
  stepResult: unknown;
  modelCalls: number;
  toolCalls: number;
  costUnits: number;
  fitness: number;
  failureReason?: string;
  rollbackTo?: number;
  hash: string;
}

/** In-memory, JSON-serializable map of runId → ordered checkpoints. */
export class CheckpointStore {
  private map = new Map<string, Checkpoint[]>();

  /** Append (or replace by step) a checkpoint for its run, keeping step order.
   *  Steps normally arrive in order, so the common path is an O(1) push with no
   *  re-sort; we only sort when a checkpoint actually lands out of step order. */
  save(cp: Checkpoint): void {
    const list = this.map.get(cp.runId) ?? [];
    const existing = list.findIndex((c) => c.step === cp.step);
    if (existing >= 0) {
      // Replace in place; the existing entry's position already preserved order.
      list[existing] = cp;
    } else {
      const last = list[list.length - 1];
      list.push(cp);
      // Only re-sort if the new step broke the ascending-by-step invariant.
      if (last !== undefined && cp.step < last.step) list.sort((a, b) => a.step - b.step);
    }
    this.map.set(cp.runId, list);
  }

  /** All checkpoints for a run, ordered by step (empty if none). */
  load(runId: string): Checkpoint[] {
    return (this.map.get(runId) ?? []).slice();
  }

  /** The highest-step checkpoint for a run, or undefined. */
  latest(runId: string): Checkpoint | undefined {
    const list = this.map.get(runId);
    if (!list || list.length === 0) return undefined;
    return list[list.length - 1];
  }

  /** Serialize the whole store to a JSON string. */
  serialize(): string {
    return JSON.stringify({ runs: Array.from(this.map.entries()) });
  }

  /** Rehydrate a store from a serialize() string. */
  static deserialize(s: string): CheckpointStore {
    const store = new CheckpointStore();
    const parsed = JSON.parse(s) as { runs: [string, Checkpoint[]][] };
    for (const [runId, list] of parsed.runs) store.map.set(runId, list);
    return store;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Content-addressed call cache. The point: even when work is re-derived during a
// resume, the model call behind it is served from cache (hit) and never re-issued.
// ─────────────────────────────────────────────────────────────────────────────

/** Memoizes compute() by hashJson of {genomeId, step, input}. */
export class CallCache {
  private store = new Map<string, unknown>();
  private hits = 0;
  private misses = 0;

  /** Return the cached value if present (compute NOT called); else compute + store. */
  getOrCompute<T>(
    key: { genomeId: string; step: number; input: unknown },
    compute: () => T,
  ): { value: T; hit: boolean } {
    const k = hashJson(key);
    if (this.store.has(k)) {
      this.hits += 1;
      return { value: this.store.get(k) as T, hit: true };
    }
    this.misses += 1;
    const value = compute();
    this.store.set(k, value);
    return { value, hit: false };
  }

  /** Cache counters (hits, misses, distinct entries). */
  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.store.size };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The durable run loop.
// ─────────────────────────────────────────────────────────────────────────────

/** A single unit of work in a run. `run` is deterministic given ctx. */
export interface RunStep {
  name: string;
  run(ctx: { policy: PolicyObject; prior: unknown }): {
    state: unknown;
    result: unknown;
    fitnessDelta: number;
    modelCalls: number;
    toolCalls: number;
    costUnits: number;
  };
}

/** Result summary of a (possibly partial) durable run. */
export interface RunOutcome {
  completed: boolean;
  checkpoints: Checkpoint[];
  fitness: number;
  /** Model calls actually ISSUED this invocation (cached/skipped calls excluded). */
  modelCallsIssued: number;
  /** Step index this invocation resumed from (0 = fresh run). */
  resumedFrom: number;
}

/**
 * Execute steps with durable checkpointing.
 *
 * Fresh run: executes each step, persists a checkpoint after each. If `crashAfter`
 * is set, it persists steps 0..crashAfter then STOPS (completed:false) — simulating
 * a kill after the work was durably recorded.
 *
 * Resume (same store): the already-checkpointed prefix is REPLAYED from persisted
 * state — no step.run() and no model calls for those steps. Execution continues at
 * the first un-checkpointed step. A CallCache backs any re-derived work so model
 * calls are served from cache rather than re-issued.
 */
export function runWithCheckpoints(opts: {
  runId: string;
  genomeId: string;
  steps: RunStep[];
  policy: PolicyObject;
  store?: CheckpointStore;
  cache?: CallCache;
  crashAfter?: number;
}): RunOutcome {
  const store = opts.store ?? new CheckpointStore();
  const cache = opts.cache ?? new CallCache();
  const persisted = store.load(opts.runId);
  const resumedFrom = persisted.length; // first step not yet checkpointed

  // Rehydrate cumulative state from the persisted prefix (replay, no execution).
  let prior: unknown = null;
  let fitness = 0;
  for (const cp of persisted) {
    prior = cp.state;
    fitness = cp.fitness;
  }

  let modelCallsIssued = 0;

  for (let step = resumedFrom; step < opts.steps.length; step += 1) {
    // Content-addressed: the model call behind the step is cached by {genome,step,input}.
    const key = { genomeId: opts.genomeId, step, input: prior };
    const { value: out, hit } = cache.getOrCompute(key, () =>
      opts.steps[step].run({ policy: opts.policy, prior }),
    );
    // Only count model calls that were actually issued (cache miss = real call).
    if (!hit) modelCallsIssued += out.modelCalls;

    prior = out.state;
    fitness += out.fitnessDelta;

    const cp: Checkpoint = {
      runId: opts.runId,
      step,
      genomeId: opts.genomeId,
      state: out.state,
      stepResult: out.result,
      modelCalls: out.modelCalls,
      toolCalls: out.toolCalls,
      costUnits: out.costUnits,
      fitness,
      hash: hashJson({ step, state: out.state, fitness }),
    };
    store.save(cp);

    // Simulated crash: durably recorded through `crashAfter`, then stop.
    if (opts.crashAfter !== undefined && step >= opts.crashAfter) {
      return { completed: false, checkpoints: store.load(opts.runId), fitness, modelCallsIssued, resumedFrom };
    }
  }

  return { completed: true, checkpoints: store.load(opts.runId), fitness, modelCallsIssued, resumedFrom };
}
