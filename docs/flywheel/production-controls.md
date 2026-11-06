# Explicit production promotion controls

Status: proposed implementation; offline validation only. No deployment, paid inference,
Arena submission, external model change, or Autogenous runtime integration is included.

## Why a separate mode

Issue [#319](https://github.com/ruvnet/metaharness/issues/319) deliberately preserved the
research wrapper's fallback to its base gate when paired evidence is missing or empty.
That contract remains intact. Library calls without `promotionMode` retain research
behavior and now identify their bundles as `promotion_mode: "research"`.

`promotionMode: "production"` opts into a separate fail-closed path. The flywheel CLI
uses production by default; old CLI experiments must explicitly select research. The
CLI no longer invents `LIVE` provenance. Existing benchmark scripts using the library
remain research callers until they supply the full production contract; a `LIVE` label
alone is not statistical verification.

## Production evidence and selection

1. Freeze the effective manifest before any provider observation. A durable admission
   record includes its fingerprint before the baseline evaluator is invoked.
2. Evaluate the baseline and candidate policies on the selection suite. Choose exactly
   one candidate using the frozen base rule and primary-score ordering.
3. Evaluate that frozen winner and its actual parent on a fresh independent suite for
   that comparison. Never select another candidate using these outcomes.
4. Require suite-aligned boolean item outcomes from both arms, identical ordered source
   task IDs, live evaluator provenance, the expected evaluator/corpus/policy digests,
   and a nonempty informative pairing. Missing or malformed evidence is INCONCLUSIVE.
5. Apply the selection base rule, the independent score/no-op/cost/safety rule, and the
   paired sequential evidence threshold. A configured frozen anchor is an additional
   guard, including the full evaluator safety flag, not only its numeric score.

Each suite has explicit stable source-task IDs and a seed. Promotion suites must be
mutually disjoint and disjoint from selection and anchor data by both source ID and
canonical item bytes. The entire family has a fixed `maxComparisons`; each generation
uses its own never-reused suite. Its threshold uses `alpha / maxComparisons`. This
bounds family error by a union bound **assuming each paired e-value satisfies its null
validity conditions**. It does not make correlated, contaminated, or adversarially
renamed tasks statistically independent. Numeric accumulation uses log space to avoid
irreversible floating-point overflow/underflow.

The in-process callbacks are trusted adapters. The library does not sandbox a proposer
that already holds a reference to secret suites or prove evaluator truthfulness.
`LIVE`, sample IDs, model/artifact identities and independence declarations must come
from a trustworthy evaluation system. Signatures authenticate recorded claims; they do
not establish that real-world execution occurred. This patch provides no family-error
claim across newly registered families; the owner must preserve the preregistered
family and budget identity instead of resetting them after looking at results.

## Canonical gate identity and replay

The production manifest binds version, gate/helper implementation digests, alpha,
lambda, comparison family and maximum, base-rule source/configuration/dependencies,
evaluator source/model/artifact identity, dependency fingerprint, selection/anchor/
independent corpora and seeds, root policy, mutation targets, and budget identity/units.
Snapshots prevent ordinary callback/config mutation from changing the recorded policy.
A custom rule must declare its closed-over configuration and helper dependency digest;
this cannot freeze arbitrary mutable JavaScript closure state or verify a dishonest
artifact declaration. Deploy only trusted, immutable implementations.

The sequential research wrapper now fingerprints its captured alpha/lambda and base
rule, fixing the identical-fingerprint/different-decision case. The bare default gate's
historical source fingerprint remains unchanged. Old pins for composed wrappers need
explicit migration; unchanged old source-only pins cannot prove captured parameters.

Production roots, candidate records, checkpoints and final bundles are signed. Replay
requires independently supplied gate and signer pins, validates full manifest/evidence/
budget binding, re-executes the gate, and recomputes deltas and aggregate lift metrics.
It detects downgrade to a research bundle when a production signer is requested. An
embedded key or bundle-supplied fingerprint is not an independent trust anchor.

Example verification:

```ts
verifyReplayBundle(bundle, {
  pinnedGateFingerprint: approvedFingerprint,
  pinnedPublicKey: approvedSignerPublicKey,
  // promotionRule: the independently pinned production rule, if using a custom base
});
```

CLI replay accepts `--gate-fingerprint <hex> --signer-public-key <base64>`. Custom base
rules need the programmatic API and independently supplied production rule for replay.

## Hard admission budgets and recovery

Production requires `hardBudget: { limiter, evaluatorUnits, proposerUnits }`, where
`limiter.durable` is true. Every baseline, proposer, candidate, independent paired arm
and optional anchor call reserves **before** invocation. Executed failures, aborted
calls, pending calls and uncertain calls consume their full reservation permanently.
There is no refund API. A denied call never invokes the provider.

Units are positive safe integers, such as bounded calls or microdollars. They must be
an upper bound on the adapter's real cost, including retries and fallback operations.
A reservation at the injected-function boundary does not meter a provider's internal
work or impose its token cap. The old `budget.spent()` field remains a clearly labeled
research-only soft generation boundary.

`FileBudgetLimiter` is a local cooperating-process ledger: exclusive mkdir lock,
append-only hash chain, fsynced records and head sidecar, synced directory updates.
The sidecar detects a cleanly truncated tail. Reservations have unique family/slot
IDs that omit disposable root/run IDs. Concurrent workers cannot double-admit a slot
or exceed the total. Restart restores the same ledger. Signed checkpoints bind its
identity, total and exact operation-history prefix, rejecting same-ID replacement
ledgers padded with unrelated spend.

File-backed durability requires Linux/macOS and a local filesystem implementing the
stated fsync/atomicity semantics. Windows fails with `BUDGET_UNSUPPORTED_PLATFORM`
before writing anything; use a separately validated durable adapter there. Tests on
Windows exercise denial and the common/orchestration contracts with an explicitly
synthetic adapter; Linux/macOS exercise the persistent implementation. Network
filesystems and malicious filesystem writers are outside this contract.

Any uncertain write or stale lock fails closed. Never automatically steal the lock,
truncate the ledger, refund pending reservations, or recreate the ledger. An operator
must reconcile external execution and the ledger/head before continuing. A crash
between a reservation and a generation checkpoint may make that slot unreplayable;
it stays charged and requires reconciliation, rather than silently re-executing it.
Production checkpoint errors stop the run; research observation-hook compatibility
still swallows them. This is conservative at-most-once admission, not exactly-once
provider execution or automatic crash recovery.

## Reproduction and benchmark

```sh
npm install --ignore-scripts --package-lock=false
npm run build --workspace @metaharness/flywheel
npm run test --workspace @metaharness/flywheel
node packages/flywheel/scripts/reproduce-production-controls.mjs
node packages/flywheel/scripts/benchmark-production-controls.mjs
```

The reproduction requires baseline commit
`e0dfd44da72b7adfb7c57fdd42d124be58ed7086` in local Git history. It transpiles those exact
historical sources into a temporary directory using the installed TypeScript package.
Recorded output is [production-controls-reproduction.json](production-controls-reproduction.json).

Observed before/after, entirely synthetic and $0:
- Old soft two-evaluator budget executed six evaluations and promoted once.
- New two-unit hard envelope executed one evaluator plus one proposer, then stopped
  before the candidate evaluation; zero promotions. Proposers are now counted too.
- Old missing evidence promoted; production returns INCONCLUSIVE.
- Old alpha .05/.9 wrappers had equal fingerprints and unequal decisions; new pins differ.
- A sequence with 1,810 wins then 1,800 losses overflowed the old e-value and falsely passed;
  log-space accumulation correctly rejects it.

The benchmark includes local manifest construction, all evaluator/proposer fixture
calls, durable reservations/fsync, independent evaluation, Ed25519 receipts, and full
replay. It reports p50/p95 and invocation counts, plus a seeded fixed-family null/power
simulation. This measures control overhead and synthetic behavior, not real model
quality, production latency, monetary ROI, hardware throughput, or held-out task gains.

## Deliberately separate work

Arena [#384](https://github.com/ruvnet/metaharness/issues/384) remains independently owned
and on HOLD. This patch does not resolve its provenance/reconciliation findings.
Autogenous [#10](https://github.com/ruvnet/autogenous/issues/10) still needs independent
holdout and resource evidence. No deployment binding, canary rollback, external
independent auditor, or live production isolation is established here.

### Latest recorded local benchmark

[Raw benchmark output](production-controls-benchmark.json) records Node 24 on Linux,
25 measured runs per mode, plus 1,000 null and 1,000 injected-effect families. Two
production generations required 10 evaluator calls + 2 proposer calls (12 reserved
units), versus 6 + 2 in research; the extra calls are the independent paired checks.
The fixed-family null acceptance was 3/1,000 (0.3%; Wilson 95% interval 0.102–0.878%);
injected discordant candidate-win probability .65 yielded 878/1,000 accepted families
(87.8%; 85.626–89.685%). Timing quantiles are environment-dependent and are recorded
in the JSON instead of serving as a CI performance threshold.
