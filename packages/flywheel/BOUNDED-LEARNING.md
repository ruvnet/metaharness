# Bounded learning, opt-in research API

`runBoundedLearning` is exported by `@metaharness/flywheel`. It adds a training-only
proposal stage and a single final confirmation stage to the available library APIs.
Existing `runFlywheelGenerations`, Darwin, and signed promotion gates are unchanged.
This API never promotes or deploys candidates. A passing result means REVIEW_REQUIRED,
not production approval or proof of recursive self-improvement.

## Integration contract

A trusted Ruflo worker adapter implements `LearningAdapters.propose` and `evaluate`.
Dream Machine can supply the proposer; the trusted evaluator resolves private suite
identities from its own storage. Only baseline policy and training scores are passed
to the proposer. Policies contain string levers, not executable code. Allowed levers
are frozen by the caller; permissions should not be listed as mutable levers.

The host must implement actual isolated workers, hard process termination on abort,
provider cost reservations, and independently measured costs. In-process callbacks
are trusted and are NOT a security sandbox. Never execute model-generated JavaScript
in these callbacks. This change does not install or provision a Ruflo worker.

Require two genuinely distinct task families. Freeze model/provider, evaluator,
source revision and disjoint training/confirmation corpora before dispatch. Digest
inequality detects identical split identities; it cannot establish absence of item
leakage. The independent evaluator must enforce that and assign evidenceClass.

`evaluate` receives train, confirm, rewrite, remove and corrupt stages. Implement
real skill interventions and use identical paired task IDs and trials for both arms.
The core cannot verify that an adapter actually performed an intervention. Evaluate
rewrite/removal/corruption against the baseline under the SAME intervention.
The proposer is never called after confirmation. Strategy quality across later
untouched generations still requires the existing multi-generation proof verifier.

## Frozen acceptance rules

At most three proposal rounds. Call, integer micro-dollar, and time ceilings are
validated before dispatch. Reservations precede calls; failed calls retain their
full reservation, so reported costs can be conservative estimates. No paid calls
are made by the core itself. Known costs must fit the reservation.

Require >=10% successful completions per dollar in each family and each confirmation
or drift condition, zero success-count regression, equal trials and zero permission
violations. Also require >=10% full-cycle efficiency: all training and proposal
costs, including unsuccessful attempts, are charged to the selected candidate.
No speculative future traffic amortizes development costs. Synthetic fixtures never
satisfy the useful-improvement gate. These are point-estimate checks, not statistical
significance or causality tests. Reviewers must independently confirm the result.

Each result seals configuration, source/split digests, observations, candidate,
cost reservations, call count and verdict in an Ed25519 receipt. Pin the expected
signer's public key in the consumer; an embedded key alone conveys no authority.
Store verified lessons in RuVector only after independent confirmation, with source,
task scope, expiry and revalidation trigger. Do not store raw private examples or keys.

## Validation and publication status

All bundled tests use synthetic deterministic adapters. They validate control flow
and rejection behavior, not a learning gain. No live model call, benchmark, candidate
promotion, schedule change or npm release is performed by these tests.

Repository-wide npm ci currently fails on five missing optional native-kernel
entries in the existing lockfile. Package tests can be run with isolated pinned
TypeScript 5.9.2, Vitest 2.1.9 and Node 20 type definitions without modifying that
lockfile. Both ESM and CJS builds must pass. Publish a review branch first; defer a
package release until real isolated-worker integration and independent evidence
satisfy the success condition and normal signed release/provenance requirements.

## Existing work to reuse

[PR 407](https://github.com/ruvnet/metaharness/pull/407) already provides Darwin
contrastive development and independent paired statistical confirmation. This
experimental Flywheel API does not replace it. A production adapter should reuse
that confirmation implementation; the additional scope here is the cross-family
skill-drift matrix and full-development-cost rejection. No second live pilot was
run. PR 407's reported CLINC pilot found equal confirmation scores and higher cost,
so it is not evidence for promoting a learned policy. The new API remains a draft
until it is wired to those real workers and independently evaluated.
