// @metaharness/evals-toolcall — a benchmark ADAPTER for @metaharness/flywheel.
//
// BFCL-style function-calling / tool-use treated as a POLICY-EVOLUTION problem, not a model-training problem:
// freeze the models, the evaluator, and the private holdout; let the flywheel evolve ONLY the harness policy
// that decides how to select a tool, format its arguments, verify the call against the schema, retry, escalate,
// abstain, and calibrate. The policy — not the model — is the genome. Tool-calling is HARNESS-BOUND: the
// biggest recoverable bucket, an ideal policy-evolution target.
//
// This package is NOT core logic: it exports a `Proposer` + `Evaluator` (+ a stricter composite gate) that
// plug into the benchmark-agnostic flywheel. The flywheel never learns what "tool-calling" is.
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
