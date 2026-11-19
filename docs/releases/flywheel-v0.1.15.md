# @metaharness/flywheel 0.1.15: fail-closed production gates and durable budgets

Package: `@metaharness/flywheel@0.1.15` only. Source: #387.

## Added

- `promotionMode: 'production'`. Promotion needs fresh, disjoint, independent paired suites and a fixed comparison-family alpha. Missing, malformed or noninformative evidence is `INCONCLUSIVE`, never a promotion.
- Durable hard budgets, charged before each baseline, proposer, candidate, independent or anchor call: `FileBudgetLimiter` (Linux/macOS; it fails closed on Windows) and `InMemoryBudgetLimiter`. Failed and uncertain calls stay charged. Neither concurrency nor a restart can admit the same slot twice.
- Production receipts bind the gate manifest, evaluator, corpora, dependencies, root policy and budget history. Replay requires independently pinned gate and signer identities (`--signer-public-key`).

## Fixed

- `sequentialEvidence` works in log space, so long runs no longer overflow or underflow the e-value. A favorable prefix followed by 1,800 losses now rejects.
- `withSequentialEvidence` fingerprints its alpha/lambda configuration, so differently configured gates no longer share one identity.

## Behaviour change

- `metaharness flywheel run` (the `@metaharness/flywheel/cli` dispatch) defaults to production. A research CLI config must set `promotionMode: 'research'`. The library default stays research, so existing `runFlywheelGenerations` callers are unchanged. The `metaharness` umbrella pins flywheel 0.1.14 exactly, so its CLI does not change until that pin moves.

The README quickstart was run against the packed tarball in a clean directory. Output: lift curve 0.00 -> 0.33 -> 0.67 -> 1.00, 3 promotions, replay verifies true.
