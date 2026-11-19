# Validation receipt, revision 2

Date: 2026-11-17

Base: de4f3c90c211ce726d4096f93fa2eed303be1f56, MetaHarness PR 510.
No production promotion, publish or deployment is authorized by this receipt.

## Change

The assignment adapter defaults to bounded classical exact matching. Integer
optima are independently checked using a primal/dual certificate. Generic energy
search remains explicit and uncertified. Inputs use bounded indexed copies;
labels are typed numeric copies; training updates preserve the cost range.

## Validation

* Full MetaHarness TypeScript build passed.
* Energy strict type check passed.
* 48 energy tests and 3 ADR format tests passed, including 400 independent
  exhaustive assignment cases and mutable-input regressions.
* A separate agent review ran 1000 additional small exhaustive comparisons
  with masks, rectangular shapes and signed costs: no mismatch or certificate
  failure. Reviewer findings were fixed and given regression tests. Separate
  agent review is not proof of independent authorization principals.
* Runner coverage, repository health, path guard and diff checks passed.
* Full repository suite: 4025 passed, 62 skipped across 354 passing test files.
* Isolated packed package install and integer certificate smoke passed.
  Package includes compiled declarations, validation receipt and benchmark runners/reports.

## Benchmarks

The current report is bench/assignment-v2-validation.json. On the same 1000
synthetic cases as v1, all 906 feasible optima are recovered and certified,
versus 904 recovered by the prior energy strategy. Zero invalid output, false
infeasibility or false optimality claims. All eight larger planted and
metamorphic fixtures pass, including 64 by 64 assignments.

Warm amortized exact timings are about 214x lower than prior energy search on
this fixture distribution. Exact calls are batched; energy calls are timed
individually. This is a local elapsed-time comparison, not a service latency,
production cost, generic reasoning or CRAM speedup claim. The exhaustive oracle
is independent but deliberately unoptimized. Large optima are planted, not an
arbitrary large matching oracle. Real production replay remains outstanding.

## Existing CI findings

The first PR head failed the ADR format gate because ADR 324 lacked the canonical
Status markup and Consequences section. Both are fixed and the format test passes.
CodeQL's prototype-assignment warning was addressed by typed numeric label copies,
explicit numeric sink indices and regressions for hostile array behavior.
A fresh CodeQL run is still needed to confirm the scanner outcome.

The first head's Rust cargo audit and deny failures concern the existing graph
resolving chrono 0.4.45 with RUSTSEC-2026-0543 through rs_poker and ruvector-core.
This change introduces no Rust dependency. The base previously had successful
checks; the current advisory result must not be described as an already failing
base. No advisory was suppressed or ignored by this change.

## Reproduce

```sh
npm ci --ignore-scripts
npm run build
npx vitest run --maxWorkers=2
npm run lint --workspace @metaharness/energy
node scripts/check-runner-coverage.mjs
node scripts/path-guard.mjs
node packages/energy/bench/assignment-v2.mjs
node packages/energy/bench/sparse.mjs
```

Acceptance: exact output agrees with the independent oracle, every integer
optimum verifies, no returned state violates a constraint, and work limits are
honored. Keep opt in until real replay establishes zero accepted violations,
quality within 1% of exact and at least 2x lower planning cost or p95 latency
than the current production planner. Rollback is the optional import removal.
