# Contrastive development loop security review

Date: 2026-10-16 UTC
Reviewer: independent Codex security workstream
Scope: `packages/darwin-mode/src/contrastive`, experimental development API only.

## Threat model

Untrusted task, library and model output data may contain hostile JSON, invalid evidence, oversized trees or unsupported component edits. The caller, evaluator, proposer and composer functions are trusted effect adapters. Assets are the immutable capability envelope, task/evidence integrity, tenant boundaries, bounded call admission and separation from production promotion.

The core never executes component content, accesses credentials, writes files, calls a network or promotes production state. Candidate content remains data. Integrators that execute content must apply their existing validation and OS isolation controls.

## Evidence

Reviewed source commits: core `3ab724c`, memory/editor bridge `f8bd318`, accounting fix `b62673d`. Combined review checkout: `63700ae` before this report/test commit.
Baseline lock SHA256: `043b1a6ac8454b18d2bf656eed881a5341ff21270d7c9d370c7a436e1614d8a0`.
Node: `v20.20.2`; Vitest: `2.1.9`.
Final rerun at 16:37:54 UTC: 47/47 independent adversarial tests passed (120 ms). Combined core and adversarial suites: 69/69 tests passed; overall 1.06 s.
Typecheck: `tsc --noEmit` exited 0.

Commands, from `packages/darwin-mode`:

```sh
../../node_modules/.bin/vitest run __tests__/contrastive-adversarial.test.ts --maxWorkers=1 --minWorkers=1
../../node_modules/.bin/tsc --noEmit
```

The suite checks immutable nested snapshots, hostile accessors and keys, cyclic/oversized input, mismatched tenant/project libraries, invalid scores/costs/observations, citation and scope escapes, digest mismatch, preflight reservations, exhausted budgets, late resolution, synchronous deadline overrun, no verifier or promotion callback leakage, actual candidate probing and unsupported composition.

## Findings and disposition

No confirmed critical or high issue in the reviewed development core.

1. Exact decimal budget sums could conservatively reject an affordable final call. Correctness issue; never enabled overspending. FIXED in `b62673d` using safe integer nanodollar reservations. Independent regression confirms seven USD 0.10 calls fit a USD 0.70 budget exactly.
2. Initial portable-memory retrieval returned entire stored records after partial validation. Additional top-level verifier/score fields or altered promotion metadata could reach an editor. Medium integrity/confidentiality concern at the persisted-library boundary. FIXED before commit `f8bd318`: strict field, status, promotion and evidence validation. Independent regressions reject selectedScore, verifierSecret, invalid status and promotion fields; valid records still round-trip.

## Residual limitations

Adapters can lie about costs, digest application and development scores. An echoed digest is an attestation by a trusted adapter, not cryptographic proof of execution. Production admission must independently enforce cost and capability boundaries.

Cancellation signals stop core acceptance and further calls. They cannot forcibly terminate arbitrary JavaScript, native code, a provider request or effects started by an adapter. Isolation and cancellation enforcement remain adapter responsibilities.

The JSON and dependency validator does not parse or certify scripts stored in component content. This review does not establish generated-code safety, model success gains or transfer accuracy. Development preference is explicitly `promotion: not-authorized`.

This workstream ran targeted source review, typechecking and adversarial tests. It did not install an additional scanner runtime, contact an advisory feed or conduct network penetration tests. Advisory timestamp: not applicable to this targeted review. Integration release owner must separately record dependency audit evidence.

## Final gate

PASS for the reviewed experimental API scope: both findings are fixed, all 69 focused tests pass and typechecking exits 0. Release owner must bind final packaging and dependency evidence to its integration commit. This review neither authorizes production promotion nor establishes a provider sandbox or model quality gain.
