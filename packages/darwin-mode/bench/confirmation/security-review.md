# Independent confirmation security and statistics review

Date: 2026-10-16 UTC. Scope: opt-in confirmation API and CLINC pilot design.
Core reviewed: `b1c85b8` plus `888dae5` (review checkout `fb41869`).

## Verification

Node v20.20.2; Vitest 2.1.9. At 17:05:14 UTC: 56 independent adversarial cases and 43 engine cases passed, 99 total, in 1.23 seconds. TypeScript `tsc --noEmit` exited 0 after the deadline fix.

From `packages/darwin-mode`:

```sh
../../node_modules/.bin/vitest run __tests__/contrastive-confirmation-adversarial.test.ts __tests__/contrastive-confirmation.test.ts --maxWorkers=1 --minWorkers=1
../../node_modules/.bin/tsc --noEmit
```

Tests cover scope, immutable inputs, malformed outcomes, budgets, overspend, timeouts and receipts. Exact p values match hand cases and an independent BigInt reference across 101 tails and 4096-case extremes. Ties, forbidden regressions and incomplete winning prefixes cannot confirm.

## Findings

No outstanding confirmed critical/high issue in the reviewed API.

1. Policy provenance and per-pair outcome receipts were initially incomplete. FIXED before `b1c85b8`: frozen policy and policy/development/environment/envelope digests; successful receipts include outcome booleans so counts can be reconstructed.
2. Per-pair timeout reset could exceed the declared round cap. Independently reproduced: two 6 ms pairs confirmed under a 10 ms cap. FIXED by `888dae5`; the exact test now returns inconclusive after one valid case.
3. Initial pilot comparisons tested both arms against baseline, which does not establish superiority over control. FIXED before live execution: contrastive versus baseline and contrastive versus control, Bonferroni alpha 0.025 each. Both gates must pass for a comparative conclusion.
4. Benchmark provider semaphore now hands permits directly to queued waiters; returned model identity is checked against the pinned ID.

## Limits

The exact paired test assumes an appropriate sampling design and exchangeable discordant signs under the null. It does not prove causality or general agent capability. No optional early acceptance occurs within a run. Preventing repeated candidate tests, changed policies or reused confirmation data requires an external experiment registry and multiplicity policy.

Task IDs alone cannot prove distinct underlying examples, exclusion from model training or honest evaluation. The pilot additionally checks distinct texts and pinned dataset bytes. Public CLINC may be in model training. Forty balanced cases from eight intents are a limited pilot. Equal development ceilings do not mean equal actual spend.

Adapters remain trusted effect boundaries. Scope/digest echoes are attestations; cancellation cannot forcibly terminate arbitrary external effects. `confirmed` never authorizes production promotion. No credentials, model responses or paid calls were used by this review workstream.

## Rust CI blocker

CI job 117087176673 and cargo-audit job 117088647612 fail resolving poker-darwin -> candle-core ^0.8 -> zip ^1.1.1; every compatible zip release is yanked. Workspace Cargo.lock is absent and ignored. Cargo-audit fails before advisory scanning, so this is not a clean Rust audit. Cached registry independently confirms the dependency chain. Candidate fix: aligned Candle core/nn 0.9.2, neural-feature validation and a tracked workspace lockfile. Candle 0.9.0/0.9.1 still depend on the yanked zip range. No Rust dependency changes were made.

Gate: PASS for reviewed API changes and targeted tests. Whole-repository merge remains blocked by Rust CI until independently remedied. Live pilot outcomes and final package evidence are separate integration-owner receipts.
