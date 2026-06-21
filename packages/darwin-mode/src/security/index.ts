// SPDX-License-Identifier: MIT
//
// Darwin Shield — defensive zero-day discovery harness (ADR-155).
//
//   model_frozen = true ; harness_evolves = true ; unsafe_output = rejected
//
// The security application of the Darwin Plus stack (ADR-077…081): change the
// task to defensive vulnerability discovery and the fitness function, keep the
// thesis — the foundation model is frozen, the harness evolves, the proof is in
// the replayable receipt.
//
// Pipeline: profile → rank → context → hypotheses → static + fuzz → review →
// SAFETY GATE → patch → score → archive (ruVector memory + receipts).
//
// Modules:
//   util     — deterministic primitives (seeded RNG, embeddings, rounding)
//   types    — the shared contract (genome, finding, memory schema, receipts)
//   policy   — the safety layer: scope gate, exploit redactor, unsafe-output gate
//   genome   — creation, bounded mutation, crossover, baselines
//   corpus   — DARWIN-SHIELD-BENCH substrate (seeded vulns, decoys, clean repos)
//   memory   — ruVector security memory: hybrid ranking, negative/genome memory
//   agents   — swarm agents + the capability model (genome → detection/FP power)
//   scoring  — frozen per-finding score + genome-level fitness
//   swarm    — RuFlo-coordinated pipeline for one genome (with receipts)
//   evolve   — the Darwin loop (mutate / evaluate / select / archive)
//   bench    — DARWIN-SHIELD-BENCH + acceptance gates + report rendering

export * from './util.js';
export * from './types.js';
export * from './policy.js';
export * from './genome.js';
export * from './corpus.js';
export * from './memory.js';
export * from './agents.js';
export * from './scoring.js';
export * from './swarm.js';
export * from './stats.js';
export * from './compounding.js';
export * from './ablation.js';
export * from './selfwrite.js';
export * from './invariant.js';
export * from './agentic.js';
export * from './semgrep-oracle.js';
export * from './codeql-oracle.js';
export * from './real-loop.js';
export * from './real-evolve.js';
export * from './fuzz-oracle.js';
export * from './evolve.js';
export * from './bench.js';
