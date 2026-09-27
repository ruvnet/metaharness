# ADR-318: Multi-generation improvement proof protocol

**Status**: Proposed  
**Date**: 2026-09-26  
**Issue**: #357  
**Scope**: `@metaharness/flywheel`

## Context

RuV already has several different classes of self-improvement evidence:

- Darwin Mode has a reproducible synthetic multi-generation capability climb when the mutation surface contains a reachable gradient.
- The RuFlo bounded-RSI mission preserves durable lineage, matched controls, negative results, cost accounting, replay, and an explicit requirement for three descendant generations.
- Independent-review context isolation now separates reviewer evidence from worker social context.

What is still missing is a reusable proof object that distinguishes:

1. **multi-generation capability improvement** — child policies get better over several generations;
2. **recursive improver improvement** — a child also becomes better at producing the next improved child under the same improvement budget;
3. **synthetic/development evidence** — useful for mechanism qualification but not RSI proof;
4. **independent confirmation** — untouched workloads, externally frozen workload identities, and reviewer identities pinned outside the candidate process.

Without this separation, a lineage such as `G0 -> G1 -> G2 -> G3` can be over-interpreted. A chain of better policies does not by itself show that the improver became better.

## Decision

Add an additive `MultiGenerationEvidence` verifier to `@metaharness/flywheel`.

The verifier never runs a model, executes a candidate, changes a promotion gate, or grants authority. It only evaluates a supplied evidence envelope.

Every generation binds:

- parent and child identity;
- source digest;
- selection-set digest;
- confirmation-set digest;
- evidence class;
- baseline and child outcome;
- parent and child **improver probes**;
- exactly matched improvement budgets;
- frozen/static/shuffled/previous controls;
- two or more reviewer attestations;
- `authority: none`.

### Capability improvement

A generation counts as capability-improved only when it satisfies the frozen policy:

- at least 3 absolute points higher primary quality while cost/win does not worsen; **or**
- at least 20% lower cost/win with no primary-quality regression;
- zero safety violations;
- zero protected regressions.

These are protocol defaults, not universal RSI thresholds.

### Improver improvement

For a fixed successor-generation budget, define:

`successor yield = successful improved successors / allowed successor attempts`.

A generation supports recursive-improver evidence only if child successor yield exceeds parent successor yield by at least 5 percentage points.

The child improver probe for generation `n` must byte-match the parent improver probe used at generation `n+1`. This prevents replacing the improver measurement between generations.

### Controls

Each generation requires four matched controls:

- frozen;
- static;
- shuffled;
- previous.

The child must exceed the strongest control primary score by at least 1 absolute point under the same improver budget.

The verifier rejects missing controls and budget mismatch.

### Evaluation exposure

Selection and confirmation sets must have different digests.

Confirmation-set digests must be unique across generations.

This does not prove semantic non-overlap. It creates a fail-closed identity boundary for an externally managed exposure ledger. The workload owner remains responsible for constructing genuinely disjoint sets.

### Reviewer independence

Reviewer attestations are Ed25519 receipts already supported by `@metaharness/flywheel`.

A reviewer is trusted only if:

- its reviewer id appears in the verifier expectation;
- its public key exactly matches the externally pinned key;
- counted reviewers must use distinct signing keys;
- the receipt signature verifies;
- the signed payload binds run, generation, parent, child, evidence digest, reviewer id, verdict, and `authority: none`.

The embedded key alone is not trust. The caller must pin reviewer identities externally.

### Independent confirmation

A generation cannot obtain the strongest proof class merely by setting `evidenceClass: independent_confirmation`.

The verifier additionally requires each confirmation-set digest to appear in an externally supplied list frozen by the workload owner before candidate outcomes are visible.

## Proof classes

The verifier returns one of:

- `INVALID`
- `STRUCTURAL_MULTI_GENERATION`
- `SYNTHETIC_RECURSIVE_IMPROVER`
- `BOUNDED_RECURSIVE_IMPROVER`
- `INDEPENDENT_CONFIRMATION`

The class is deliberately narrower than terms such as AGI or unrestricted RSI.

## Security properties

1. Evidence never becomes execution authority.
2. Every generation carries `authority: none`.
3. Reviewer signatures bind the exact generation evidence digest.
4. Reviewer identity is pinned outside the evidence bundle.
5. Post-attestation mutation invalidates reviewer acceptance.
6. Reusing a confirmation-set identity fails closed.
7. Changing improver budgets across parent/child or control arms fails closed.
8. Safety violations or protected regressions invalidate the generation.
9. The strongest confirmation class requires an externally frozen confirmation-set list.
10. RVM and existing human-controlled policy remain the final effect boundary.

## Initial structural qualification

A pre-PR local prototype was compiled with:

- Node 22.16.0
- TypeScript 5.8.3
- Linux x86_64
- provider cost: $0
- energy: not measured

Seven deterministic qualification cases passed:

1. valid three-generation synthetic recursive-improver lineage;
2. improver plateau rejected;
3. confirmation-set reuse rejected;
4. insufficient capability lift rejected;
5. post-attestation tampering rejected;
6. externally pinned independent-confirmation fixture classified correctly;
7. false sealed-set list prevented independent-confirmation classification.

A 10,000-case structural benchmark over five seeds used 4,000 valid and 6,000 adversarial cases across six attack families. The pre-PR prototype produced zero false accepts and zero false denials. Total end-to-end benchmark wall time was 20.537 s on the local environment; mean verifier call time measured separately in the prototype was approximately 1.475 ms. These measurements must be rerun on the exact PR head in CI before they are treated as branch evidence.

This is **proof of verifier behavior only**. It is not proof that RuV has achieved recursive self-improvement.

## Required behavioral confirmation

The existing RuFlo RSI mission should consume this verifier only after its execution budget, isolation, and evaluator ownership gates are satisfied.

The confirmation experiment requires:

- at least three fresh workload families;
- three descendant generations;
- current parent plus frozen/static/shuffled/previous controls;
- identical model, tool, capability, and improvement budgets;
- evaluator-hidden confirmation sets;
- two externally pinned reviewer identities;
- full acquisition and evaluation cost accounting;
- preserved rejected candidates and interrupted charges.

The result supports bounded recursive self-improvement only if all three generations improve both task capability and successor-generation yield on untouched confirmation workloads.

## Rejected alternatives

### Count three promotions as RSI

Rejected. Three better descendants can be produced by the same unchanged improver.

### Use only final generation score

Rejected. It loses lineage, budget, control, and generational causality.

### Trust evaluator names in JSON

Rejected. Names are not authenticated identity.

### Let the candidate choose confirmation-set ids

Rejected for independent confirmation. The strongest class requires a list pinned by an external workload owner.

### Replace RVM promotion/authority policy

Rejected. This verifier classifies evidence only.

## Rollback

The change is additive.

Rollback removes:

- `multigeneration-proof.ts`;
- its exports;
- tests;
- benchmark;
- workflow;
- this ADR.

No stored-data migration is required. Existing Flywheel, Darwin, reviewer-isolation, and RuFlo RSI evidence remain unchanged.

## Cross-stack mapping

- **MetaHarness**: proof verification, controls, reviewer isolation, replay.
- **RuFlo**: candidate generation and existing bounded-RSI mission.
- **Core Memory**: immutable evidence/exposure ledger and negative results.
- **RuVector / RuVector WASM**: retrieval of prior evidence without authority.
- **RVM**: capability and effect boundary; unchanged.
- **RVF / RVForge**: evidence and artifact provenance.
- **Autogenous / Dream Machine**: proposal generation only.
- **MidStream**: generation lifecycle events and cost telemetry.
- **RuView / RuField / WorldGraph**: future domain-specific sealed workload families.
- **LatentMesh**: transport of evidence as untrusted data.
- **Cognitum**: potential enterprise assurance around independently demonstrated autonomous improvement.
- **MCP / distributed infrastructure**: tools may provide evidence; they cannot mint proof authority.

## Acceptance

The PR may advance for review when:

1. TypeScript build passes;
2. focused tests pass;
3. the 10,000-case exact-head benchmark has zero false accepts and zero false denials;
4. security/dependency CI remains green;
5. no existing promotion or authority rule is weakened.

A merge of this verifier would still not establish RSI. Real proof requires the separate sealed behavioral experiment described above.
