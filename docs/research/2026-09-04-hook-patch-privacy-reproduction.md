# 2026-09-04 RuV reproduction program

Tracks: ruvnet/metaharness#281

## Scope

This program independently evaluates three originating-team results against frozen RuV baselines:

1. HookPry lifecycle-hook supply-chain execution
2. PatchBench root-cause vulnerability repair validation
3. UMPeek black-box inference of hidden personalization state

No result from an originating paper promotes RuV code until this program reaches an independent ACCEPT verdict.

## Role separation

Research freezes source claims, versions, datasets, licenses where verifiable, and exclusions. Baseline owns the unmodified RuV condition. Implementation may create only adapters needed to exercise candidate primitives. Adversarial review owns transformed attacks and degradation cases. Security owns authority, privacy, tenant isolation, and supply-chain assumptions. Testing owns deterministic and resource-bound validation. Reproducibility pins environment and commands. Release produces ACCEPT, REJECT, or INCONCLUSIVE and has no merge authority.

## Global freeze rule

Before candidate outcomes are visible, commit a manifest containing:

* repository and candidate commit SHA
* evaluator commit SHA
* workload identifiers and digests
* model and harness versions
* hardware and operating system
* dependency lock digests
* seeds
* sample size
* metric definitions
* budgets for time, tokens, cost, memory, and requests
* protected invariants
* negative controls

Changing any frozen item starts a new experiment family.

## Track A: lifecycle-hook authorization

Baseline: current RVM and harness behavior without the candidate gate.
Candidate: ruvnet/rvm PR 65.

Use synthetic ephemeral plugins only. Cases cover benign install followed by malicious update, plugin substitution, prior-manifest substitution, event widening, rights widening, command substitution, epoch replay, expired grant, repeated update, malformed input, and legitimate scoped update.

Report unauthorized hook bindings, rights widening, legitimate acceptance, p50 and p95 local validation latency, CPU time, memory, receipt size, and failures.

Acceptance requires zero unauthorized bindings and rights widening on correctly represented cases, legitimate acceptance within one absolute percentage point of baseline, and local gate latency below 100 microseconds p95.

## Track B: root-cause patch evaluation

Baseline A: original proof-of-concept outcome only.
Baseline B: proof of concept plus current regression suite.
Candidate: ruvnet/dream-machine PR 77.

Use seeded vulnerable programs and freeze the original trigger, transformed or transplanted attacks, legitimate negative controls, root-cause oracle, and evaluator versions before repair generation.

Report apparent solve rate, root-cause solve rate, false promotion rate, legitimate patch rejection, patch similarity when a historical fix exists, model cost, evaluator cost, runtime, and regressions.

Acceptance requires at least 50 percent lower false security promotion than the stronger baseline while legitimate patch acceptance stays within three absolute percentage points.

## Track C: personalization exposure

Baseline A: no persistent personalization.
Baseline B: current Core Memory plus RuVector personalization.
Instrumentation candidate: ruvnet/core-memory PR 55.

Probe only synthetic profiles owned by the experiment. Compare fixed and adaptive probing under identical request budgets. Include attributes that are present, absent, stale, contradicted, revoked, and outside tenant scope. Evaluate response-only and stateful defenses only after baseline leakage is established.

Report user-model recovery, false inference, personalization utility, latency, input and output tokens, model cost, request budget, and cross-tenant disclosure.

A defense may be considered only if it reduces attacker recovery by at least 50 percent relative to the undefended RuV personalization baseline, retains at least 90 percent personalization utility, and produces zero cross-tenant disclosure.

## Governance

Evidence is not authority. Evaluator success cannot grant capabilities, merge code, deploy software, alter credentials, mutate production data, or relax policy. RVM remains the authority boundary. Attack artifacts stay inside isolated synthetic test environments. Negative and null results are durable outputs.
