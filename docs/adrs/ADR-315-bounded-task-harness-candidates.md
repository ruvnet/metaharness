# ADR 315: Bounded Task Harness Candidates

Status: proposed

Date: 2026-09-15

Issue: #315

## Context

JIT-Agent (arXiv:2608.25593) treats an agent harness as a machine-generated task-adaptive artifact with four modules: memory, planning, action, and capability or tool orchestration. The originating team reports material benchmark gains across several model families and tasks. Those results are external and have not been independently reproduced by RuV.

MetaHarness already generates static repository harnesses, computes a generator genome, runs Darwin and flywheel optimization, records replay evidence, and applies independent promotion gates. What is missing is a minimal contract for accepting a model-generated task-specific harness as an untrusted candidate without letting generated content define its own capability boundary, evaluator, or promotion criteria.

## Decision

Introduce `TaskHarnessCandidate` as an additive, non-executable evidence envelope.

A candidate binds:

1. an exact task digest
2. optional parent lineage digest
3. generator identity, version, and source digest
4. exactly one memory, planning, action, and capability module, each with artifact and configuration digests
5. requested capabilities
6. canonical generation time
7. explicit `authority: none`

Validation receives the capability ceiling separately from the candidate. Requested capabilities must be a subset of that operator supplied ceiling. The candidate cannot carry or rewrite the ceiling.

The normalized candidate is canonicalized before SHA-256 hashing so semantically irrelevant ordering of modules and capability lists does not change identity.

## Invariants

1. Generated harness content is evidence, not authority.
2. Validation never executes generated code.
3. Capability admission is monotonic attenuation from an external ceiling.
4. The four module kinds are complete and unique.
5. Unknown fields fail closed so generated content cannot smuggle evaluator or policy controls into the envelope.
6. Task, generator, parent, module artifacts, and module configuration are digest bound.
7. Candidate digests are deterministic under permitted ordering changes.
8. RVM remains the privileged effect boundary at execution time.
9. MetaHarness promotion remains independent and unchanged.
10. Existing `Genome`, `HarnessPlan`, templates, and scaffold behavior remain intact.

## Security model

The contract prevents a candidate from declaring more capability than an independently supplied ceiling, but it does not prove generated artifacts are safe or correct. Artifact digests provide identity, not trust. A malicious generator can still produce harmful code inside an allowed capability set. Execution therefore requires a separate sandbox, RVM authorization, protected tests, security review, and MetaHarness evaluation.

The capability ceiling must originate below mutable model context. If a generator can choose both the request and the ceiling, the invariant is meaningless.

## Benchmark

A deterministic five-seed benchmark covers 10,000 candidates and compares a naive shape-only baseline with bounded validation. Attack classes include capability expansion, duplicate module kinds, and unknown policy-shaped fields. Clean reordered candidates verify digest stability.

The benchmark reports baseline and candidate false acceptance, clean false denial, deterministic digest mismatches, throughput, p95 batch latency, runtime environment, seeds, sample size, cost status, energy status, and reproduction command.

The benchmark is a structural security regression. It is not a reproduction of JIT-Agent task-quality results.

## Cross-stack implications

RuVector and RuVector WASM may index candidate artifacts and prior outcomes without granting capability. RuFlo, Autogenous, and Dream Machine may generate candidates. MetaHarness evaluates candidates independently. RVM supplies the real capability boundary. RVF can package candidate and evaluation digests. RVForge can package only promoted artifacts. MidStream can carry candidate lifecycle events. RuView, RuField, and WorldGraph can specialize candidates for sensing and spatial tasks while preserving actuator boundaries. LatentMesh can transport candidate artifacts without adding trust. Cognitum can expose the contract for per-task enterprise runtimes. MCP capabilities remain server authorized.

## Migration and rollback

The change is additive. It adds a package subpath export, source module, tests, benchmark, and documentation. It changes no persisted schema and no existing harness generation behavior. Rollback removes those additions without modifying existing manifests or generated harnesses.

## Governance

No autonomous merge, deployment, credential escalation, policy weakening, evaluator mutation, or irreversible migration. Production use requires independent reproduction of both structural security and task-level utility against a strong static harness baseline.
