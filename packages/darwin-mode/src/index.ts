// SPDX-License-Identifier: MIT
//
// @metaharness/darwin — Darwin Mode (ADR-070…075).
//
// Bounded, empirical, population-based self-improvement of an agent harness.
// The foundation model is frozen; the HARNESS evolves: generate child variants
// over seven approved mutation surfaces, sandbox-score them, archive the lineage
// as a tree (not a single best branch), and promote only measured, safe wins.
//
//   The model proposes nothing here — the harness mutates, the benchmark judges,
//   the archive remembers.
//
// Modules:
//   types          — the shared contract
//   safety         — the load-bearing allowlist + content gate (ADR-071)
//   repo_profiler  — repo → RepoProfile
//   templates      — the seven baseline mutation-surface sources
//   generator      — RepoProfile → baseline variant
//   mutator        — bounded, validated child mutations + the CodeGenerator hook
//   openrouter-mutator — optional LLM-backed CodeGenerator (same safety gate)
//   sandbox        — gate-first, shell-free, env-scrubbed task runner
//   scorer         — the frozen weighted scorer + strict promotion gate (ADR-072)
//   archive        — the population tree + archive-wide selection (ADR-073)
//   evolve         — the loop that composes them all (ADR-070)

export * from './types.js';
export * from './safety.js';
export * from './repo_profiler.js';
export * from './templates.js';
export * from './generator.js';
export * from './mutator.js';
export * from './openrouter-mutator.js';
export * from './ruvllm-mutator.js';
export * from './phenotype.js';
export * from './epistasis.js';
export * from './clade.js';
export * from './curriculum.js';
export * from './pareto.js';
export * from './mock-sandbox.js';
export * from './tier2-sandbox.js';
export * from './sandbox.js';
export * from './scorer.js';
export * from './archive.js';
export * from './evolve.js';

// The benchmark + SOTA "Darwin Plus" layer (ADR-076…081) is namespaced to avoid
// name collisions (e.g. scoreWeights) with the lightweight ADR-072 scorer.
export * as bench from './bench/index.js';

// Darwin Shield — the defensive vulnerability-discovery harness (ADR-155).
// Namespaced to avoid collisions (e.g. mutate/evolve/fitness) with the kernel
// loop above. The model is frozen; the security harness evolves; unsafe output
// is rejected.
export * as security from './security/index.js';
