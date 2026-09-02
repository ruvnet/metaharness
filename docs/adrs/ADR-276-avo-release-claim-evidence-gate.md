# ADR-276: AVO exact-SHA release claim evidence gate

**Status**: Accepted (library verifier, governed-surface scanner, CI check, and mandatory publish gate implemented; no performance or frontier evidence accepted yet)
**Date**: 2026-08-21
**Project**: `ruvnet/metaharness`
**Related**: ADR-231 (SOTA attestations), ADR-250 (proof ladder), ADR-251 (`@metaharness/avo`)

## Context

ADR-251 described an AVO-class benchmark boundary, but its original
`evaluateShipGate()` accepted caller-labelled aggregate JSON. It did not bind a
release commit, freeze the protocol before execution, verify an external trust
root, require independent graders, bind cost and lineage evidence, bind the
exact claim semantics, or run in the npm publish workflow. A README sentence
could therefore outrun the evidence even while the numeric helper returned
`ship: false` elsewhere.

The security asset is not only package integrity. It is the credibility of a
public performance statement. A self-signed receipt proves internal integrity,
not who should be trusted or what proposition was actually graded.

## Decision

Add a fail-closed verifier to `@metaharness/avo` and make it a mandatory tag-SHA
publish step.

### 1. Claims are explicit and covered

`packages/avo/release-claims.json` is the release declaration. It MUST contain
at least one claim and list every governed public surface. The CLI reads those
files through repository-confined, symlink-aware, bounded paths.
The required surface set is also pinned in protected verifier source, so a
manifest-only edit cannot silently remove `README.md` from coverage.

Mechanism claims are accepted only when ID and statement exactly match the
source-controlled `REGISTERED_MECHANISM_CLAIMS` registry. The initial statement
is deliberately narrow: the package exports an API and versioned evidence
schemas. It does not assert that the current runtime has closed every authority,
budget, checkpoint, or evaluator gap.

Performance and frontier claims are accepted only when ID, classification, and
statement exactly match `SUPPORTED_RESTRICTED_CLAIMS`. The governed-surface
scanner rejects an additional undeclared affirmative AVO performance statement.
This is defense in depth rather than a general natural-language theorem prover;
the exact registry is the primary semantic boundary.

### 2. Claim semantics are preregistered

The signed preregistration contains, for every restricted claim:

```text
{ claimId, classification, statementHash, predicateId }
```

The first supported predicate is
`swebench-relative-lift-20-v1`: 100 unseen tasks per arm, identical task set,
at least 20 percent relative verified-resolution lift, less than 50 percent
cost-per-accepted increase, zero policy violations, and complete replay
integrity. The benchmark receipt and both graders bind the resulting
`claimSetHash`. A generic passing bundle cannot authorize a substituted
"world-best" or "100 percent" statement.

### 3. Evidence is exact-SHA and pre-execution

The preregistration and benchmark receipt bind:

1. Repository and exact 40-character release commit SHA.
2. Package name, version, and SHA-256 of the exact npm tarball to be published.
3. Signed preregistration hash and a registration time before run start.
4. Sealed unseen task-set hash and exactly 100 tasks in each of three arms.
5. Fixed model, reasoning configuration, token budget, evaluator version, and
   frozen thresholds.
6. Measured USD total reconciled against all arm totals, a provider-usage
   receipt hash, and the preregistered maximum total cost.
7. A 300-run manifest root, checkpoint-manifest root, action-receipt root,
   replay-receipt root, counts, and verification attestations.

Every numeric aggregate is runtime-validated for finite range and internal
consistency before `evaluateShipGate()` executes.

### 4. Trust is external to the bundle

Ed25519 keys embedded only in evidence are never trusted. A trust policy pins
registration, run, and grader SPKI keys. The publish job additionally requires
`AVO_CLAIM_TRUST_POLICY_HASH`, a protected repository or environment variable
whose digest must match the complete policy. Replacing the evidence and its
caller-supplied trust policy together therefore fails.

Every preregistered grader must return a valid signature over the exact result,
claim set, task set, source SHA, and lineage hash. At least two graders are
required with distinct pinned keys and distinct organizations, using the
official SWE-bench Docker method.

### 5. Publication is bound to the tag

All publish jobs check out the explicit tag. The npm job resolves the tag to a
commit and fails unless it equals `HEAD`. After build and tests it packs AVO
once, hashes that tarball in `scripts/avo-claim-gate.mjs`, and passes the same
path to `publish-workspace.mjs`. The exact bytes verified by the gate are the
bytes sent to npm. The claim gate runs before any `npm publish` call. CI also
runs the default mechanism-only claim check on every pull request.

`CODEOWNERS` assigns the claim registry, verifier, CLI, and publish workflow to
`@ruvnet`. Repository branch protection MUST require Code Owner review; the file
alone cannot enforce GitHub settings.

## Threat model

| Abuse case | Control | Residual risk |
|---|---|---|
| Self-signed fabricated run | Externally pinned policy digest and Ed25519 verification | Compromised pinned key |
| Evidence replayed from another build | Exact preregistered SHA and npm tarball digest equal the tagged release | Malicious code at an approved SHA |
| Post-hoc thresholds or task set | Signed preregistration predates run and binds protocol | Registration authority collusion |
| One grader impersonating two | Unique keys plus distinct pinned organizations | Two organizations can still collude |
| Generic evidence reused for an exaggerated claim | Exact protected statement and signed claim-set hash | External marketing outside governed surfaces |
| Hidden spend | Arm-total reconciliation, measured-cost flag, usage-ledger hash, ceiling | The provider receipt bytes remain external evidence |
| Fabricated lineage verification booleans | Both independent graders bind and attest the lineage hash | This gate trusts graders; it does not replay all receipt leaves itself |
| Workflow bypass | Mandatory pre-publish step, exact tag check, CODEOWNERS | Admins can bypass branch/environment protection |

## Consequences

The default release still passes because it makes one narrow mechanism claim.
Adding any performance or frontier claim without the protected policy hash and
complete evidence fails publication. Verification is local, deterministic, and
normally under 100 milliseconds, excluding bounded JSON reads.

The gate does not prove that a task set was truly unseen, that independent
organizations are economically independent, or that the AVO runtime is secure.
Those are governance and runtime-assurance boundaries. In particular, signed
`receiptChainsVerified: true` fields are attestations made accountable by pinned
graders, not a substitute for replaying every leaf from the manifests.

## Test contract

Tests MUST cover: exact valid chain; empty claims; mechanism mislabelling;
undeclared governed-surface claim; protected-surface removal; semantic
substitution; SHA or package-artifact replay; replaced trust policy; signature
tampering; self-signed grader; same-organization graders; missing cost, sample,
lineage, or grader; and a signed result below the frozen performance threshold.
