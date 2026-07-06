// @metaharness/evals-servedmodel — a ruvllm served-model ADAPTER for @metaharness/flywheel (ADR-234).
//
// Treats a live SONA/MicroLoRA micro-loop adaptation as a POLICY-EVOLUTION problem: freeze the frozen
// `meetsPromotionRule`, the anchor discipline, and the signed-receipt machinery; distill a promoted
// micro-loop STATE into a typed serving-policy GENOME and let the flywheel gate it exactly like the
// HLE/SWE-bench adapters. This package is NOT core logic — it exports a `Proposer` + `Evaluator` (+ a
// stricter composite gate + a pure distillation function) that plug into the benchmark-agnostic flywheel.
export * from './genome.js';
export * from './driftguard.js';
export * from './score.js';
export * from './data.js';
export * from './state.js';
export * from './evaluator.js';
export * from './gate.js';
export * from './ruvllmClient.js';
