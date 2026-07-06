// @metaharness/evals-hle — a benchmark ADAPTER for @metaharness/flywheel.
//
// HLE (Humanity's Last Exam) treated as a POLICY-EVOLUTION problem, not a model-training problem: freeze the
// models, the evaluator, and the private holdout; let the flywheel evolve ONLY the harness policy that
// decides how to answer, verify, route, abstain, and calibrate. The policy — not the model — is the genome.
//
// This package is NOT core logic: it exports a `Proposer` + `Evaluator` (+ a stricter composite gate) that
// plug into the benchmark-agnostic flywheel. The flywheel never learns what "HLE" is.
export * from './genome.js';
export * from './classifier.js';
export * from './normalizer.js';
export * from './verifier.js';
export * from './calibration.js';
export * from './routing.js';
export * from './leakage.js';
export * from './score.js';
export * from './gate.js';
export * from './data.js';
export * from './evaluator.js';
