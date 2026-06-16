// SPDX-License-Identifier: MIT
//
// Shared types for the Algorithmic Agent Harness (ADR-047).
//
// The harness treats models as interchangeable workers and algorithms as the
// control plane. These types are the contract between the deterministic control
// modules (scoring, safety, recovery, verification, consensus, receipts) and the
// pluggable workers the harness conducts.

/** A unit of work for the harness to satisfy. */
export interface Goal {
  /** Free-text description of what the user wants. */
  text: string;
  /** Optional pre-classified intent; if absent the IntentClassifier picks one. */
  intent?: string;
  /** Arbitrary structured context handed to workers. */
  context?: Record<string, unknown>;
}

/** Hard ceilings the harness must never exceed in a single run. */
export interface Budget {
  /** Max total spend, USD. */
  costUsd: number;
  /** Max risk any single action may carry (0..1). */
  risk: number;
  /** Max number of retries across the whole run. */
  retries: number;
  /** Min confidence required to execute an action (0..1). */
  confidence: number;
}

/** Sensible default budget — generous cost, conservative risk/confidence. */
export const DEFAULT_BUDGET: Budget = {
  costUsd: 1.0,
  risk: 0.5,
  retries: 4,
  confidence: 0.6,
};

/**
 * What a worker reports after doing a unit of work. Workers (models, tools,
 * skills) are functions; the harness owns everything else. Every field feeds the
 * utility invariant in `score.ts`.
 */
export interface WorkerOutput {
  /** The produced artefact (code, text, JSON, …). */
  output: unknown;
  /** Self/critic-estimated quality, 0..1. */
  quality: number;
  /** Confidence the output is correct, 0..1. */
  confidence: number;
  /** Estimated risk of executing/accepting this output, 0..1. */
  risk: number;
  /** Spend incurred producing this output, USD. */
  costUsd: number;
  /** Wall-clock latency, milliseconds. */
  latencyMs: number;
}

/** A worker: a model/tool/skill wrapped as a pure-ish function over an input. */
export type Worker = (input: WorkerInput) => Promise<WorkerOutput> | WorkerOutput;

/** What a worker receives: the step, the goal, and any upstream results. */
export interface WorkerInput {
  goal: Goal;
  step: PlanStep;
  /** Outputs of already-completed steps this one depends on, keyed by step id. */
  upstream: Record<string, unknown>;
}

/** A registered worker in the pool. */
export interface AgentSpec {
  /** Stable worker id, e.g. "coder", "reviewer". */
  id: string;
  /** Model label recorded on receipts, e.g. "haiku". */
  model: string;
  /** The kinds of plan step this worker can handle. */
  handles: string[];
  /** The worker implementation. */
  run: Worker;
}

/** One node in the plan DAG. */
export interface PlanStep {
  id: string;
  /** Step kind, e.g. "plan", "code", "verify" — matched against AgentSpec.handles. */
  kind: string;
  /** Step ids this step depends on (must complete first). */
  deps: string[];
}

/** A verdict from the verifier layer. */
export interface Verdict {
  pass: boolean;
  /** 0..1; verifiers may report partial confidence in their own check. */
  score: number;
  /** Human-readable reasons, especially on failure (drives the critique loop). */
  reasons: string[];
}
