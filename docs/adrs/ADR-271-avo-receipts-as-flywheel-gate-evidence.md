# ADR-271 — AVO receipts as flywheel-gate evidence: reconciling harness and gateway governance

- **Status:** Implemented (harness-side) — the `@metaharness/avo` adapter + cross-repo proof tests ship; the gateway is UNCHANGED (the non-goal). Registering the harness signing key in the gate allowlist is the one operational step to go live.
- **Date:** 2026-08-22 · **Updated:** 2026-08-22 (implemented; corrected for meta-llm #118 signer-allowlist)
- **Repos:** authored in `agent-harness-generator/docs/adrs/` (AVO side) and mirrored verbatim into `cognitum-one/meta-llm/docs/adr/` (gateway side)
- **Related:** metaharness ADR-251 (`@metaharness/avo` GovernedVariationOperator); meta-llm ADR-249 (flywheel gate, `POST /v1/flywheel/gate`), ADR-245 (`/v1/evolve` + genome promote/rollback), ADR-263/238 (OaK signed policy envelopes), ADR-227 (intervention-distillation flywheel), ADR-270 (per-request `usage.cost`)

## Context

A recurring question — *"is meta-llm updated with the AVO capabilities?"* — has a plain answer: **no.** There is zero `GovernedVariationOperator` / `@metaharness/avo` code in `meta-llm/src`, and there should not be by copying AVO's runtime into the serving gateway. The only AVO-*derived* change to meta-llm so far is ADR-270 (`usage.cost`), and that is still an open PR.

But "no AVO code" is not the whole picture, and the naïve fix (port AVO's runtime into the gateway) is the wrong one — because **meta-llm already implements the same governance model AVO does**, under different names:

| Governance primitive | AVO — harness side (`packages/avo/src`) | meta-llm — gateway side (`src/evolve/gate.ts`, `src/oak/*`) |
| --- | --- | --- |
| Signer | `Ed25519ReceiptSigner` (`crypto.ts`), `ReceiptSigner` port | `node:crypto` ed25519 `sign`/`verify` (`evolve/gate.ts`), `signOakPolicy` (`oak/signing.ts`) |
| Signed record | `ActionReceipt` / `VariationCheckpoint` — `stateHash`/`checkpointHash` + `signature`, hash-chained | `SignedReceipt { payload, signature, publicKey }`; OaK `TrajectoryReceipt` |
| Canonical hash | `checkpointHash()` over the unsigned checkpoint | `canon()` over the receipt payload |
| Promotion gate | `correct ∧ safe ∧ replayable ∧ noRegression ∧ budget ∧ protectedTestsPassed ∧ zeroViolations ∧ improved` (`operator.ts:325`, `repository.ts`, `archive.ts`) | `meetsPromotionRule` + 5 VERIFY checks: `holdout ∧ security ∧ drift ∧ replay ∧ governance` (`gate.ts` `GateInput`) |
| Trust model | evaluate the *evidence*, never the agent's claim; a forged score keeps the seed as winner | "the gate never evaluates trust from CLAIMS; it only evaluates SIGNED RECEIPTS" (`gate.ts` header) |
| No-serve invariant | verified seed remains the winner; nothing auto-promotes | SHADOW → holdout; `flywheel/gate` NEVER auto-serves |
| No leakage | conformance firewall — the in-loop signal never reads the hidden test | `holdout_receipt` is verified *before* any dev-metric comparison |

AVO is the **harness-side producer** of exactly the kind of signed, gate-checkable evidence that meta-llm's flywheel gate is the **gateway-side consumer** of. They were designed to the same invariant on two sides of the same boundary. What is missing is not capability — it is a **contract** that lets one feed the other, instead of two parallel Ed25519 receipt formats that never meet.

## Decision

Define a **receipt-shape contract** so an AVO run's signed evidence is admissible to `meta-llm`'s existing flywheel gate — and stop there. No AVO runtime enters the gateway.

1. **AVO keeps emitting its receipts unchanged** — `ActionReceipt`/`VariationCheckpoint`, Ed25519, hash-chained. The GovernedVariationOperator stays entirely in `@metaharness/avo`.
2. **A thin adapter, harness-side** (`receiptsToGateInput`, in `@metaharness/avo`), serializes the promoted checkpoint's gate evaluation into the gate's five `SignedReceipt`s, with payloads matching the shapes `gate.ts` already documents:
   - AVO `correct ∧ protectedTestsPassed` + holdout task result → **`holdout_receipt`** (`{ host, cheap_model, task_class, evidence: PromotionEvidence }`)
   - AVO `zeroViolations` / `safe` → **`security_receipt`** (`{ …, security_regression: boolean }`)
   - AVO `noRegression` → **`drift_receipt`** (`{ …, laggedFalsifier }`)
   - AVO `replayable` (the `checkpointHash` recompute) → **`replay_receipt`** (`{ baseline_manifest_hash, candidate_manifest_hash, decision }`)
   - AVO `budget` (with per-call cost now on the wire via ADR-270) → **`cost_receipt`** (`{ …, cost_per_resolved }`)
   - AVO `improved` → the metric delta the gate compares *after* the receipts verify
3. **Submit to `POST /v1/flywheel/gate`** (`flywheel:gate` scope). The gate runs `meetsPromotionRule` + its five VERIFY checks **unchanged** — it is the product; this ADR only feeds it — and returns its graded verdict plus a signed `decision_receipt`, persisting every attempt to the F-P1 lineage ledger.
4. **Promotion stays SHADOW → holdout.** An AVO run that passes the gate is a *candidate*, exactly as ADR-249/245 already require. Nothing auto-serves.

## Consequences

- **One governance definition, two sides.** The harness that *produces* variations and the gateway that *admits* them share a single receipt-and-gate contract instead of two look-alike Ed25519 formats. AVO benchmark runs (e.g. the ADR-251 three-arm SWE-bench trials) become gate-auditable "provable-agent-CI" submissions rather than self-reported numbers.
- **No gateway hot-path change, no new capability surface.** The gate, `meetsPromotionRule`, OaK, and the lineage ledger are untouched. The only new code is harness-side (a serializer + an HTTP client) plus, at most, a documented public-key exchange.
- **`usage.cost` (ADR-270) closes the cost half.** The per-call price the gateway now surfaces is the natural source for the AVO `budget` gate and the gate's `cost_receipt` — the two ADRs compose.
- **Trust is preserved end to end.** Because the gate verifies signatures over canonical payloads before comparing any metric, a compromised harness cannot promote a forged win — the same property AVO's malicious-agent test already asserts locally.

## Non-goals

- **No `GovernedVariationOperator` runtime inside the gateway.** That would duplicate OaK/evolve and is explicitly rejected.
- **No auto-serve or auto-promote** from an AVO run — SHADOW → holdout is unchanged.
- **No new crypto.** Both sides are already Ed25519; this is a serialization + canonicalization-alignment contract, not a new trust primitive.

## Implementation (2026-08-22)

Shipped harness-side in `@metaharness/avo` — the gateway is untouched.

- **`packages/avo/src/flywheelGate.ts`** — `receiptsToGateInput(summary, signer)` serializes an `AvoRunSummary` (baseline-arm vs candidate-arm benchmark metrics) into the five Ed25519 `SignedReceipt`s over the gate's exact `canon`; `submitToFlywheelGate(gateInput, {baseUrl, apiKey})` POSTs to `/v1/flywheel/gate`; `gateTrustedKey(signer)` yields the base64 SPKI-DER key to register in the gateway allowlist. `canon` and `meetsPromotionRule` are byte-exact mirrors of the gateway definitions so signatures verify and the replay decision reproduces.
- **`packages/avo/__tests__/flywheelGate.test.ts`** (10 tests) — pins the producer: every receipt verifies as the gate's `receiptValid` does, scope agrees across payloads, the replay decision reproduces `meetsPromotionRule`, and the registration key matches the receipts.
- **meta-llm `tests/adr271-avo-gate-contract.test.ts`** (7 tests, on PR #356) — the end-to-end proof: the REAL `evaluateGate` returns `PASS_FOR_PROMOTION` for an AVO-shaped, trusted-signer submission and correctly fails on regression, safety, forgery, tenant-mismatch, and untrusted-signer.

### Correction — meta-llm #118 (signer allowlist)

This ADR was drafted against a gate that trusted the key embedded in each receipt. On `origin/main` the gate had already been hardened (#118): `evaluateGate(input, caller, trustedKeys)` authorizes a receipt **only when its signer is on the allowlist** (`FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON`; an empty list fail-closes at the route) — "a self-signed receipt under a throwaway key is a CLAIM with a signature." This *strengthens* the contract and promotes the former open question to a **required operational step**: register `gateTrustedKey(signer)` in the gateway allowlist, and sign every submission with a **stable** run key (ideally the keypair backing the AVO run's `Ed25519ReceiptSigner`). Both the adapter and the proof tests reflect this.

## Resolved / remaining

- **Canonicalization alignment — RESOLVED.** The adapter signs Ed25519 over the gate's exact `canon(payload)` and hashes manifests with `sha256(canon(...))`; the meta-llm proof test confirms `receiptValid` + `evaluateGate` accept the output.
- **Key trust / scope — RESOLVED by #118.** Register `gateTrustedKey(signer)`; submit with a `cog_` key holding `flywheel:gate`.
- **Field mapping edges — settled for v1.** `zeroViolations→security_regression`; `noRegression`/gold→holdout; `budget`+ADR-270 cost→`cost_receipt`; `replayable`→`replay_receipt`. `laggedFalsifier` stays `null` (AVO has no lagged telemetry) — the drift check cannot fire, which is honest.
- **Remaining (follow-up).** (a) A benchmark-runner call site that builds `AvoRunSummary` from real arm results and submits post-run; (b) the reverse direction — the gate's `decision_receipt` flowing back into AVO's archive lineage.

**IMPLEMENTED harness-side; gateway `src/` unchanged. AVO 10/10 + meta-llm contract 7/7 tests green.**
