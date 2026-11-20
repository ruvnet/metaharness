# ADR-325: Continual Self Improvement Memory for the MetaHarness optimizer

**Status**: Implemented as an opt in prototype, subject to empirical validation  
**Date:** 2026-11-20  
**Issue:** https://github.com/ruvnet/metaharness/issues/518  
**Extends:** ADR-074, ADR-071, ADR-072, ADR-073, ADR-161

## Context

The source work, Yu et al., *Self-Improvement Memory Enables Continual Recursive Self-Improvement*, https://arxiv.org/abs/2611.18856 (2026), stores optimization history by recurring harness problem so that later optimizer rounds can revise earlier edits in light of their rationale and outcomes. The memory belongs to the **harness optimizer**, not the task-solving agent. Its evidence supports continued improvement across compatible benchmark or model boundaries. Its reported empirical gains are **not** gains measured in this implementation.

MetaHarness Darwin already records local variants and their independent scores in its archive, and ADR-074 specifies RuVector evolutionary memory and Ruflo execution fabric. The missing seam was a structured, persistent, optimizer-facing experience layer with explicit attempt history and bounded continuation context.

## Decision

Introduce `SimMemory` in `@metaharness/darwin` as an opt in extension, with a versioned `metaharness.sim.v1` snapshot, append-only history, and a JSON `metaharness.sim.handoff.v1` representation for a future Ruflo orchestration adapter.

Each attempt records an opaque ID, source tenant and repo, compatible harness interface, source model/benchmark/version, recurring problem key, diagnosis, parent/variant references, mutation surface and rationale, prediction if independently available, measured score delta and final score, frozen promotion verdict, evidence IDs, and timestamp. Each local record links to the previous record with a SHA-256 hash. The hash chain detects accidental corruption; it is **not a signature or independent attestation**, and the local file is not a distributed multi-writer ledger.

Darwin retrieves context only for the optimizer at proposal time, with mode `full` or `retrieval` and explicit scope filters. Retrieval uses either a supplied embedder and vector adapter, including optional `@ruvector/rvf`, or deterministic lexical matching. Vector IDs are checked against eligible records after retrieval, so untrusted index contents cannot widen tenant/interface scope. A context budget limits inclusion. Memory text is marked **untrusted**, never promoted to a system instruction.

After independent scoring and promotion, Darwin appends the scored attempt. Failed attempts and regressions are preserved. The proposer receives prior optimizer history; the evaluator and scorer **never read SIM**. No direct change to the Darwin statistical promotion gate, risk gate, child safety validator, or selection algorithm is authorized by this ADR.

The `SimRunConfig` mode `off` or omission of the config preserves existing behavior, including absence of SIM disk writes. `allowCrossRepo` is explicit and remains bounded to the same owner and compatible interface; cross-model and cross-benchmark retrieval is allowed **only as a prior**, never as transfer evidence without independent reevaluation.

## Security and operational constraints

1. Do not store raw traces, prompt responses, hidden test details, secrets, or private user content in the SIM record. Store reference IDs and independently scored outcomes. Any external embedder must receive only explicitly approved retrieval text.
2. The owner and repo scope are required. The operator supplies a per-tenant storage path and per-tenant index path. This is not a network-facing authorization layer: tenant identity must be authenticated by the surrounding service.
3. No automatic merge or promotion on the basis of memory similarity, vector score, or an agent's own prediction.
4. No automatic release or cross-tenant learning. A future Ruflo consumer must apply least privilege, human controlled promotion and signed receipts.
5. Snapshot writes use a temporary file and atomic rename. Only one process may write a snapshot; multiple processes require an external transaction/lock service. The hash chain does not defend against a malicious writer with filesystem access.
6. Secret scanning, holdout isolation and independent benchmark sealing remain obligations of the surrounding evaluator. Existing failed trace summaries may be visible to the legacy mutator independently of SIM and should be separately audited.

## Evidence and acceptance

Run `npm run lint -w @metaharness/darwin`, `npx vitest run packages/darwin-mode/__tests__/sim-memory.test.ts packages/darwin-mode/__tests__/sim-evolve.test.ts`, and `npm run bench:sim -w @metaharness/darwin`.

The synthetic benchmark uses fixed 40 records and four matching query families, showing context precision/recall and token-budget effects. Its output explicitly says `heldoutModelScores: NOT_MEASURED`. It cannot establish LLM performance gains, production safety, vector search superiority or causal attribution. Promotion to an enabled default requires a held out, independently run three arm trial over multiple models and benchmarks, with repeated seeds, fixed candidate/round budgets, significance estimates, token and dollar costs, negative transfer, and regressions.

## Consequences

* Darwin with `sim` omitted or `mode: 'off'` behaves exactly as before and writes nothing to disk for SIM.
* With SIM on, the proposer sees bounded, untrusted prior history; scoring, promotion and the safety gates are unchanged.
* Failed and regressed attempts persist, so later rounds can revise earlier edits with their outcomes in view.
* The opt-in journal enforces one writer per path across processes with an O_EXCL lease, fencing and torn-tail recovery (#521). It is verified on local filesystems only, not NFS/SMB or under power loss.
* Measured LLM gains remain unestablished until the held-out trial described below is run.

## Alternatives

* Full unbounded history: rejected as scalable default due to cost and context saturation, retained as bounded ablation arm.
* Shared global memory: rejected due to tenant leakage, data poisoning and incompatible context.
* Vector-only retrieval: rejected; lexical fallback is explicit and deterministic without native dependencies.
* Memory-controlled selection or scoring: rejected without independent evidence and frozen score validation.

## Rollback

Omit `sim` or set `mode: 'off'`. Do not delete historical artifacts as part of rollback. Existing Darwin archive and scorer behavior are retained. If retrieval breaks, disconnect the vector adapter and continue with lexical mode explicitly; native corruption errors must not silently change scoring.
