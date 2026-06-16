// SPDX-License-Identifier: MIT
//
// @metaharness/harness — the Algorithmic Agent Harness (ADR-047).
//
// A dependency-free, deterministic control plane that wraps any model, tool,
// skill, or workflow as a replaceable WORKER. The harness owns state, selection,
// verification, cost, and governance:
//
//   The model proposes.  The harness decides.  The algorithms verify.
//
// Decision = argmax utility(action), and no action executes unless all four gates
// hold: confidence ≥ threshold ∧ risk ≤ budget ∧ cost ≤ budget ∧ verification ==
// pass. Every step emits a hash-chained receipt, so every run is replayable.
//
// Modules (one algorithm each, no shared mutable state):
//   score     — the utility invariant + the four-gate guard
//   router    — intent classifier (softmax + rules) + algorithm router (task → strategy)
//   pool      — agent pool: UCB1 contextual bandit + online reward update
//   verifier  — verifier registry + critique loop (adversarial, proposer-independent)
//   safety    — policy gate (default-deny) + risk scoring
//   recovery  — circuit breaker + retry budget (no runaway loops)
//   consensus — weighted majority / Borda count (merge multi-agent outputs)
//   receipts  — hash-chained, tamper-evident audit log
//   kernel    — the run lifecycle / 10-step execution loop that composes them all

export * from './types.js';
export * from './score.js';
export * from './router.js';
export * from './pool.js';
export * from './verifier.js';
export * from './safety.js';
export * from './recovery.js';
export * from './consensus.js';
export * from './receipts.js';
export * from './kernel.js';
