// SPDX-License-Identifier: MIT
//
// Darwin Mode — numeric genome kind (ADR-272). A second, parallel genome
// representation alongside the seven-surface prompt genome (ADR-071): a
// bounded vector of named numeric parameters (e.g. ML training
// hyperparameters), mutated by bounded perturbation/crossover instead of code
// generation, and scored by a caller-supplied external evaluator instead of
// the built-in SWE-bench-style sandbox.
//
// Deliberately independent of `types.ts`'s `HarnessVariant`/`MutationSurface`:
// those are irreducibly coupled to "a directory of seven source files" (ADR-071
// safety allowlist). A numeric hyperparameter vector is not a mutation-surface
// safety domain, so it gets its own types rather than widening that allowlist's
// union — widening it would blur the boundary the allowlist exists to hold.
export {};
//# sourceMappingURL=numeric-types.js.map