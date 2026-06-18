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
export * from './sandbox.js';
export * from './scorer.js';
export * from './archive.js';
export * from './evolve.js';
