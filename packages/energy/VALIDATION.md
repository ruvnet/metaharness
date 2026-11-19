# Validation receipt

Date: 2026-11-17

Base commit: `1dc8f009771c763c9b37d04d17e7bd8a9ec7feba`

Scope: independent TypeScript pairwise energy experiment in MetaHarness.
Proposer and local evaluator: Codex in this session. This is not an independent
review or promotion authorization. No upstream CRAM code or weights copied.

## Completed checks

* Full existing MetaHarness workspace TypeScript build passed.
* Energy package build and strict type check passed.
* 27 energy unit/property tests passed. The combined energy, field memory and
  router run passed 102 tests across 6 files.
* Test runner coverage check passed: the new package is reached by `npm test`.
* Repository health check passed; path guard passed; diff whitespace check passed.
* Package dry run contains the JS entry point, declarations, README and license;
  no runtime dependencies. Root workspace import and assignment example passed.
* Synthetic final assignment benchmark seed 90001: 1000 cases, 906 feasible,
  906 valid returned, 904 exact optima, zero invalid, zero sparse/full mismatches.
* Sparse benchmark seed 18374: 100 chain graphs, 100 variables, 99 edges,
  zero invalid and zero sparse/full mismatches; 2.37x mean scoring-path speedup.

## Interpretation

The 1% mean quality and zero violation gates passed on synthetic data. The
proposed 2x latency gate against exact enumeration failed. Neither LLM savings
nor production replay was measured. Keep experimental and opt in. Publishing,
merging, deploying, and replacing the production planner are outside this change.

## Reproduction

```sh
npm ci --ignore-scripts
npm run build
npm run lint --workspace @metaharness/energy
npx vitest run packages/energy packages/field-memory packages/router
node scripts/check-runner-coverage.mjs
node scripts/healthcheck.mjs
node scripts/path-guard.mjs
node packages/energy/bench/assignment.mjs
node packages/energy/bench/sparse.mjs
```

Benchmark reports include environment details and limitations. Timings vary;
constraint validity and integer-cost differential equivalence are the hard
acceptance checks. Promotion additionally needs real replay and an optimized
classical solver baseline.
