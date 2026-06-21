// SPDX-License-Identifier: MIT
//
// @metaharness/darwin — benchmark layer (ADR-076 + the SOTA "Darwin Plus" stack,
// ADR-077…081). Benchmark the parent vs the child, not the idea.
//
//   types      — the benchmark contract (tasks, results, suites, decisions)
//   score      — the verified-solve score + penalty layer (ADR-076)
//   gates      — the five gates: solve · regression · safety · cost · repro
//   stats      — the SEEDED bootstrap confidence (reproducible, unlike Math.random)
//   promotion  — the statistical promotion rule (ADR-076)
//   risk       — the SGM extended gate + global cumulative risk budget (ADR-079)
//   lineage    — descendant potential + clade parent selection (HGM, ADR-078)
//   suite      — immutable, hash-pinned task snapshots (anti-tampering)
//   runner     — the parent-vs-child evaluation over the secure sandbox
export * from './types.js';
export * from './score.js';
export * from './gates.js';
export * from './stats.js';
export * from './promotion.js';
export * from './risk.js';
export * from './metrics.js';
export * from './lineage.js';
export * from './suite.js';
export * from './runner.js';
//# sourceMappingURL=index.js.map