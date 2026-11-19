# @metaharness/aws-finops

<!-- ruv-seo:start (ADR-356) -->
`@metaharness/aws-finops` applies the Darwin Shield pattern to AWS cost: a cheap model proposes Terraform patches, and a deterministic oracle accepts a patch only if `terraform validate`/`plan` succeeds, `checkov` reports no new failures, and `infracost` shows the modeled monthly bill going down. It never touches live infrastructure.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. ESM only (`import`, not `require`). The core is dependency-free and runs offline on captured tool output; the `terraform`, `checkov` and `infracost` binaries are optional and skipped when absent.

## Quickstart

```bash
npm install @metaharness/aws-finops
cat > quickstart.mjs <<'JS'
import { verifyProposal } from '@metaharness/aws-finops';

// Tool output you would normally capture from terraform, checkov and infracost.
const policy = { passed: 12, failed: 0, failedKeys: [] };
const delta = { baselineMonthlyUsd: 140, patchedMonthlyUsd: 98, diffMonthlyUsd: -42 };
const proposal = { address: 'aws_ebs_volume.data', kind: 'gp2-to-gp3', rationale: 'gp3 is cheaper', requiresUtilizationEvidence: false };

const ok = verifyProposal({ buildOk: true, delta, policyBefore: policy, policyAfter: policy, proposal });
console.log('accepted:', ok.accepted); for (const r of ok.reasons) console.log('  ' + r);

const broke = verifyProposal({
  buildOk: true, delta, policyBefore: policy, proposal,
  policyAfter: { passed: 11, failed: 1, failedKeys: ['CKV_AWS_3@aws_ebs_volume.data'] },
});
console.log('accepted:', broke.accepted); for (const r of broke.reasons) console.log('  ' + r);
JS
node quickstart.mjs
```

Expected output:

```text
accepted: true
  PASS build: terraform validate/plan ok
  PASS compliance: no new checkov failures
  PASS savings: modeled bill drops 42 USD/month
accepted: false
  PASS build: terraform validate/plan ok
  REJECT compliance: patch introduces 1 new checkov failure(s): CKV_AWS_3@aws_ebs_volume.data
```

**Next:** [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) — the Darwin Mode loop and Darwin Shield oracle this harness is modeled on.

**Fit:** standalone — no published `@metaharness` package depends on it, and it has no runtime dependencies of its own. It reuses the Darwin Shield oracle pattern by design rather than importing `@metaharness/darwin`.
<!-- ruv-seo:end -->

## Reference

> **Freeze the model. Evolve the harness. Let a deterministic oracle prove the bill went down.**
> The Darwin Shield primitives (ADR-155/167), re-pointed from defensive security to AWS cost optimization — **ADR-168**.

A frozen, cheap (`$0.04`) Qwen model proposes Terraform patches. A **deterministic cost
oracle** proves the *modeled* monthly bill drops **without breaking the build or
compliance**. Only execution-verified savings are reported — behind a **human review
gate**. The harness **never** touches live infrastructure.

This is not a new method. It is the *exact* shape that worked in security
(`@metaharness/projects`), with one swap:

| Darwin Shield (security) | Darwin FinOps (cost) |
| --- | --- |
| semgrep static scan → vuln hotspots | `checkov` + `infracost breakdown` → cost/policy hotspots |
| cheap LLM triage | cheap Qwen triages genuine, low-risk optimizations |
| frontier LLM proposes a crash input | frontier Qwen proposes a **Terraform patch** |
| execution verifies the **crash** | oracle verifies **build + compliance + savings** |
| severity heuristic | modeled `$/month` saved + CloudWatch confidence |
| residual = un-fixed vulns shrinks | residual = **modeled bill** shrinks |
| defensive: no exploit output | safe: **no live-infra mutation**, patches are proposals |

## The deterministic oracle (the anti-hallucination spine)

A proposal is accepted **iff all gates pass** (`src/oracle.ts`):

1. **build** — `terraform validate`/`plan` exits 0 on the patched template;
2. **compliance** — `checkov` reports **no new** failed policies vs the baseline
   (fixing existing ones is a bonus; only *regressions* reject);
3. **evidence** — capacity changes (right-sizing) require **CloudWatch** under-utilization
   data (p95 CPU below threshold); absent evidence ⇒ reject (never guess);
4. **savings** — `infracost`'s modeled monthly bill **strictly drops** beyond an epsilon.

A model's `$0.04` patch that hallucinates savings ("just delete the database") dies at
gate 1, 2, or 4. The model is never trusted; only the tools.

```ts
import { verifyProposal, toVerifiedSaving } from '@metaharness/aws-finops';

const verdict = verifyProposal({
  buildOk: true,                                   // terraform validate/plan
  delta: { baselineMonthlyUsd: 120, patchedMonthlyUsd: 92, diffMonthlyUsd: -28 }, // infracost
  policyBefore, policyAfter,                        // checkov (normalized)
  proposal,                                         // the Terraform patch
});
if (verdict.accepted) report(toVerifiedSaving(/* … */)); // $28/mo, human-gated
```

## The cascade & shrinking residual

`runCascade()` (`src/cascade.ts`) ranks hotspots by cost, triages cheaply, proposes
cheap-first and **escalates to the frontier only on oracle-fail**, and reports
**cost-per-verified-dollar-saved**. `computeResidual()` (`src/residual.ts`) tracks the
**modeled bill that remains**; the loop terminates when no remaining hotspot yields an
oracle-passing patch (`residualConverged`).

## What's real today

- **Dependency-free, deterministic core** — types, the infracost/checkov adapters, the
  oracle, the residual, and the cascade orchestration. **34 unit tests, no binaries, no
  LLM, no network.** Fixtures mirror real `infracost` (classic `breakdown`/`diff` *and*
  modern `scan --json`) and `checkov` JSON shapes.
- **Optional binaries** (`src/binaries.ts`) — `infracost` / `checkov` / `terraform` are
  detected and **skipped when absent** (the semgrep-oracle pattern); env overrides
  `INFRACOST_BIN` / `CHECKOV_BIN` / `TERRAFORM_BIN`.
- **Real-tool discrimination bench** (`bench/real-oracle.mjs` + `bench/corpus/`) — drives
  the *actual* Terraform 1.9.8 + checkov 3.3.1 binaries over a labeled corpus and
  validates the adapters/oracle against their real JSON. Latest receipt
  (`bench/results/real-oracle.json`): **3/3 genuine savings accepted, 2/2 traps rejected
  at the correct gate** (build typo → `REJECT@build`; dropped encryption → `REJECT@compliance`
  via real `CKV_AWS_3`). The savings gate is `INFRACOST_API_KEY`-gated (no offline pricing);
  build + compliance + evidence gates run real today.

## Honesty (what we claim and what we don't)

- Savings are **modeled** against an infracost pricing snapshot — an *estimate*, not a
  billed invoice. The oracle proves the *model* improves; realized savings depend on
  actual usage and discounts (RIs/Savings Plans/EDP).
- "Without breaking the build" = `terraform validate/plan` + checkov non-regression —
  i.e. **deployable and compliant**, **not** a proof the application still behaves
  correctly. Functional correctness stays with the owning team's tests.
- **No live-infra mutation, ever.** Read-only AWS access (CloudWatch/pricing); output is
  a patch *proposal* behind a human review gate (ADR-166). This is a recommendation
  engine, not an autoscaler.

## Build & test

```bash
npm install && npm run build && npm test   # 34 tests, deterministic
```

## License

MIT © rUv. See [ADR-168](../../docs/adrs/ADR-168-aws-finops-harness.md).
