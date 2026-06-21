# ADR-168: AWS FinOps harness — the Darwin primitives applied to cloud cost (greenfield `@metaharness/aws-finops`)

**Status**: Proposed — reference implementation bootstrapped in `@metaharness/aws-finops`
**Date**: 2026-06-21
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-FINOPS`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: Cost optimization of **owned** Infrastructure-as-Code (Terraform), proposed as **human-gated patches** — never applied to live infrastructure by the harness
**Related**: ADR-155 (Darwin Shield invariants), ADR-156 (mutate structured policies, not prompts), ADR-158 (trace/cost ledger), ADR-160 (escalation scheduler), ADR-161 (memory tiers), ADR-166 (human review gates), ADR-167 (real-LLM lane, escalation router, open-frontier selection)

> This ADR records a **domain pivot**, not a new method. The Darwin Shield (ADR-155/167) proved a shape — **cheap-static + cheap-LLM triage → frontier-LLM proposal → deterministic execution oracle → only verified results reported, residual shrinks** — in defensive security. Here we keep that shape *verbatim* and swap only the substrate: the security oracle (semgrep + crash-fuzzer) becomes a **cost oracle** (infracost + checkov + `terraform validate/plan`). The model stays frozen; the harness evolves; the proof is in replay.

## Context

The security harness's value was never "an LLM finds bugs." It was the **execution-verified, cost-disciplined cascade** with a **deterministic oracle as the anti-hallucination spine**. That spine is domain-agnostic: it only needs a tool that returns a *machine-checkable verdict* on a model's proposal. Cloud FinOps supplies an unusually clean one.

In security the oracle answered *"does this input crash?"* — a boolean from execution. In FinOps the oracle answers three booleans from off-the-shelf tools, and one of them is a **signed number**:

1. **Does the patch still build?** — `terraform validate` (and, with credentials, `terraform plan`) succeeds.
2. **Does the patch break compliance?** — `checkov` (Bridgecrew) reports **no new failed policies** vs the baseline. Checkov emits structured JSON (rule id, resource, file, pass/fail) and can scan either `.tf` source or a `terraform show -json` plan.
3. **Does the patch actually reduce the bill?** — `infracost` computes the **modeled monthly cost** of the template against a cloud pricing snapshot. The classic flow is `infracost breakdown --format json` for a baseline, then `infracost diff --compare-to <baseline>` for a signed `diffTotalMonthlyCost`; modern infracost (`infracost scan --json`) additionally surfaces `monthly_cost`, `monthly_savings`, and `failing_policies` directly. Either way the oracle reduces to a **signed dollar delta** that is a pure function of (template, pricing snapshot).

This is the FinOps analogue of "the input crashes": **a frontier model's $0.04 patch is only reported if a deterministic tool proves the modeled bill went down without breaking the build or compliance.** Hallucinated savings ("just delete the database!") die at the oracle exactly as hallucinated vulnerabilities did. The prior-art "Checkov + Infracost + AI review loop" exists as a CI lint; what's novel here is wrapping it in the **Darwin cascade + shrinking-residual + cost-per-verified-saving** discipline from ADR-167.

## Decision

### 1. Bootstrap `@metaharness/aws-finops` (dependency-free, deterministic core)
A new package mirroring `@metaharness/projects`: ESM TypeScript, `tsc` build, `vitest`, zero runtime deps. The **pure core** (types, tool-output adapters, oracle, residual) is fully testable with **no binaries and no LLM** — fixtures of infracost/checkov JSON in, verdicts out. The real `infracost`/`checkov`/`terraform` binaries are **optional, skip-when-absent** (the exact pattern as semgrep in `darwin-mode`).

### 2. The deterministic cost oracle (`src/oracle.ts`) — the anti-hallucination spine, ported
`verifyProposal(before, after)` accepts a proposed patch **iff all three hold**:
- **build**: `terraform validate`/`plan` exit 0 on the patched template;
- **compliance non-regression**: `checkov` failed-policy set on the patched template is a **subset** of the baseline's (no *new* failures; fixing some is a bonus);
- **savings**: normalized `diffMonthlyUsd < 0` (modeled bill strictly decreases beyond a configurable epsilon).

Only proposals passing all three become `VerifiedSaving`s. Everything else is discarded — the model is never trusted, only the tools.

### 3. Multi-tier cascade + escalation router, reused (`src/cascade.ts`)
Same shape as `discovery.ts`/`router.ts`: **checkov/infracost hotspot scan → cheap Qwen ($0.04) triages which hotspots are genuine, low-risk optimization opportunities → frontier Qwen proposes a concrete Terraform patch → oracle verifies → escalate cheap→frontier only on oracle-fail.** Lanes are injected, so the cascade is unit-tested deterministically. Product metric: **cost-per-verified-dollar-saved** (the FinOps analogue of cost-per-verified-finding), attributed via the ADR-158 ledger. The open-frontier selection from ADR-167 (`qwen/qwen3-235b-a22b-2507` default) carries over unchanged.

### 4. Shrinking residual (`src/residual.ts`) — the loop's terminal condition, ported
In security the residual was the set of un-fixed vulnerabilities. Here it is the **residual modeled bill**: `residual = baselineMonthly − Σ(verified savings)`, plus the shrinking set of not-yet-optimized resources. Each generation that lands a verified saving monotonically shrinks the residual; the loop terminates when no remaining hotspot yields an oracle-passing, build-safe, compliance-safe patch. This gives Darwin a clean, monotone fitness signal (dollars) instead of a synthetic score.

### 5. CloudWatch as the *evidence* tier, not the oracle (`UtilizationSample`)
Right-sizing (the highest-value FinOps move) is only **safe** if the resource is provably under-utilized. CloudWatch metrics (CPU/mem/IOPS/network p50/p95/max over a window) are fed as **evidence** that gates *which* proposals are allowed (e.g. "downsize only if p95 CPU < 40% over 14 days"), not as the savings oracle. CloudWatch access is **read-only and optional**; absent metrics ⇒ rightsizing proposals are suppressed (we never guess utilization).

## Safety invariants (ADR-155 lineage, re-pointed for infra)

The defensive posture inverts cleanly from "don't emit exploits" to "don't touch production":

- **No mutation of live infrastructure.** The harness operates on **Terraform source + plan JSON only**. It holds **no write credentials**; any AWS access is **read-only** (CloudWatch/pricing). Output is a **patch proposal**, never an `apply`.
- **Human review gate (ADR-166).** Every proposed patch lands behind a review gate: high-dollar, security-relevant (checkov-touching), or low-confidence (no CloudWatch backing) patches escalate to a human. Auto-merge is never the default.
- **Honesty about "savings."** infracost numbers are **modeled** against a pricing snapshot — an *estimate*, not a billed invoice. The oracle proves the *model* improves; realized savings depend on the account's actual usage and discounts (RIs/SP/EDP). The receipt always labels savings as modeled.
- **"Without breaking the build" is bounded.** `terraform validate/plan` + checkov non-regression prove the change is *deployable and compliant* — **not** that the application still behaves correctly. Functional correctness remains the owning team's test suite. We claim deployability + compliance + modeled cost, and say so.

## Empirical results (real tools, key-gated savings)

- **Discrimination on real Terraform** (`bench/results/real-oracle.json`, analogue of `real-corpus-scan`): a labeled 5-case corpus driven through the **real binaries** — Terraform **v1.9.8** `init`+`validate -json` (build gate) and **checkov 3.3.1** `-o json` (compliance gate, via the package's `parsePolicyReport`/`newFailures`). **3/3 genuine savings accepted** (gp2→gp3, RDS rightsize with CloudWatch evidence, S3 lifecycle) and **2/2 traps rejected at the correct gate**: a typo'd argument → `REJECT@build` (terraform validate fails), and *disabling encryption to save KMS cost* → `REJECT@compliance` (real `CKV_AWS_3` new failure). **All 5 match expectation.** Notably the oracle first **caught a self-inflicted regression**: our "genuine" S3-lifecycle patch tripped `CKV_AWS_300` (missing abort-incomplete-multipart-upload) and was rejected until fixed — exactly the anti-hallucination behavior intended. The **savings gate is skip-gated on `INFRACOST_API_KEY`** (infracost's Cloud Pricing API has no offline mode); absent a key the build+compliance+evidence gates run real and the savings delta is synthetic-and-flagged (no real saving is claimed in that mode).

## Empirical plan (still to measure, mirroring ADR-167's gates)

- **Savings gate end-to-end** with an `INFRACOST_API_KEY`: real `infracost breakdown --format json` deltas on the same corpus (the adapter and oracle wiring already exist and are exercised; only the keyed pricing call is pending).
- **Cost-per-verified-dollar** (analogue of cost-per-verified-finding): total LLM spend ÷ Σ modeled monthly savings. The thesis prediction: the same $0.04 Qwen economics make the harness's own cost negligible against the bill it cuts (a $50/mo gp3 saving for fractions of a cent of inference).
- **Multi-seed gate** before any model-selection claim, using the ADR-167 paired-bootstrap (`bootstrapDelta`).
- All real-tool/real-LLM benches optional, key-/binary-gated, excluded from the deterministic `run-all`, each writing a committed receipt.

## Consequences

**What changes.** A second vertical proves the Darwin shape is substrate-agnostic: freeze the model, evolve the harness, let a deterministic oracle gate every LLM proposal. The fitness signal becomes **dollars**, which is cleaner than any synthetic score.

**What does not change.** The cascade, escalation router, ledger, memory tiers, review gates, and open-frontier selection are **reused verbatim** from `@metaharness/projects` — this ADR adds a domain adapter, not a new method. Dependency-free deterministic core; binaries optional.

**What hurts.** Savings are **modeled, not billed**; the build/compliance oracle does not prove functional correctness; rightsizing needs real CloudWatch data (skip-when-absent). The labeled Terraform corpus is greenfield and small at first. No live-infra mutation, by invariant — this is a *recommendation* engine, not an autoscaler.

## Alternatives considered

- **Let the LLM edit Terraform and apply it.** Rejected — that is the catastrophic-failure mode (an LLM `terraform apply` against prod). The oracle gates *proposals*; humans gate *application*.
- **Trust infracost's own AI/savings suggestions directly.** Rejected for the same reason we reject raw LLM findings: a suggestion is a hypothesis; only `infracost diff` on the *actual patched template* (build- and compliance-checked) is evidence.
- **Make CloudWatch the savings oracle.** Rejected — utilization is *evidence for safety*, not proof of cost reduction; the bill model is the oracle.
- **A brand-new method instead of porting Darwin.** Rejected — the whole point is that the proven primitives transfer; reuse is the result.

## Test contract

- Deterministic unit tests (no binaries, no LLM) for the oracle, residual, and tool-output adapters using committed infracost/checkov JSON fixtures.
- Real-tool benches `skipIf`-gated on `infracost`/`checkov`/`terraform` presence; real-LLM benches gated on `OPENROUTER_API_KEY`; all bounded, all writing committed receipts, all excluded from the deterministic `run-all`.
- Before any model-selection or savings claim: multi-seed + ADR-167 paired bootstrap.

## References

- Infracost — `breakdown`/`diff` JSON (`diffTotalMonthlyCost`, per-resource breakdown) and modern `scan`/`inspect --json` (`monthly_cost`, `monthly_savings`, `failing_policies`); 1,100+ resources across AWS/Azure/GCP. <https://www.infracost.io/docs/features/cli_commands/>
- Checkov (Bridgecrew) — Terraform `.tf` and plan-JSON policy scanning, structured JSON output (rule id / resource / file / pass-fail). <https://www.checkov.io/7.Scan%20Examples/Terraform%20Plan%20Scanning.html>
- Prior-art lint loop (Checkov + Infracost + AI) — the CI pattern this ADR wraps in the Darwin cascade. <https://dev.to/jackyho/building-a-devsecops-terraform-review-loop-with-checkov-infracost-and-ai-35h2>
- Internal: ADR-155 (Darwin Shield invariants), ADR-156 (program thesis), ADR-158/160/161/166/167 (the primitives reused verbatim).
