# @metaharness/darwin 0.14.0: optional ruv-fann surrogate for numeric genomes

Package: `@metaharness/darwin@0.14.0` only.

## Surrogate pre-screening (experimental)

- `evolveNumeric` accepts an opt-in `surrogate` config. Each generation proposes several times more mutation candidates than it evaluates; a surrogate model fit on the archive's own scored genomes ranks them and only the best-ranked reach the external evaluator.
- The surrogate only orders candidates. Every archived score still comes from the external evaluator, the evaluator budget per parent is unchanged, and any surrogate failure falls back to the unscreened generation with the reason recorded in `result.surrogate.fallbacks`.
- `createFannSurrogate()` supplies a model backed by `ruv-fann@0.1.2` (Rust compiled to WebAssembly). `ruv-fann` is an optional peer dependency that needs Node 20.9 or later; it is loaded only when that function is called.
- Settings cover the pre-screen (`oversample`, `minRows`, `exploreSlots`, `warmupGenerations`, `refitEvery`, `trust`, `onGeneration`) and the model (`hidden`, `activation`, `steepness`, `optimizer`, `learningRate`, `epochs`, `maxRows`, `targetTransform`, `ensemble`, `explorationWeight`, `seed`, `simd`). The CLI exposes them as `evolve-numeric --surrogate fann` and `--surrogate-*` flags.
- `NumericSurrogate` is a public port for plugging in other models.

## Evidence

A paired benchmark on three synthetic objectives (100 seeds each, six settings) is in the README and `packages/darwin-mode/bench/results/numeric-surrogate.txt`. It measures the search mechanism on smooth functions, not a real training workload.

## Compatibility

- No change when `surrogate` is not set.
- New optional peer dependency: `ruv-fann@0.1.2`. No new required dependency.
- `metaharness` (create-agent-harness) still pins `@metaharness/darwin@0.13.1`; this release does not change that pin.
