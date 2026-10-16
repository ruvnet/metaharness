# ADR 320: Independent paired confirmation

Status: accepted for the optional Darwin contrastive API
Date: 2026-10-16

## Decision and value

Development scores select hypotheses. They cannot establish that the selected configuration improves unseen tasks. Version 0.12.0 adds a separate confirmContrastive API that evaluates one frozen candidate against its baseline on a declared confirmation set.

The gate provides an explicit experimental decision before a caller considers retaining or deploying a change. It never authorizes production promotion.

## Inputs and invariants

1. The caller supplies frozen baseline and candidate documents, tenant and project scope, an environment definition, a capability envelope, development task IDs and confirmation task IDs.
2. Task IDs are unique within each partition and disjoint between partitions. Deployments should derive IDs from normalized task content; changing an ID does not make reused content unseen.
3. A trusted evaluator executes both configurations for each case under the same model, tool versions, task inputs, output limits and provider conditions.
4. Every successful pair binds to task identity, both applied document digests, tenant, project and environment.
5. Call ceilings and spend reservations are admitted before an effect. timeoutMs is one deadline for the entire confirmation phase, not a fresh timeout per pair. Failed responses cannot authorize confirmation. Cancellation rejects late results; the adapter remains responsible for stopping actual effects.
6. All declared cases must finish. There is no early acceptance and no editor callback during confirmation.
7. The result always carries promotion: not-authorized.

The evaluator retains answers and task payloads in its closure. The core receives passed booleans and execution metadata. This is a trust contract, not isolation from malicious callbacks.

## Decision rule

Count wins, losses and ties using paired binary outcomes. Apply an exact one-sided sign test to discordant pairs. Confirm only when the full set passes the caller's minimum sample, minimum wins, minimum accuracy gain, maximum regressions and significance thresholds.

The recommended initial policy is at least 20 cases, at least 5 wins, zero regressions, at least 0.05 absolute accuracy gain and alpha 0.05. Five wins and zero losses produce p = 0.03125; a tie cannot pass. This policy is intentionally conservative.

The statistical interpretation assumes independent task pairs and a prespecified candidate and policy. The API cannot police repeated use across processes. A deployment must maintain a durable confirmation-set registry, spend alpha across repeated hypotheses, and retire a set after inspecting its results. Do not tune prompts against confirmation failures and reuse the same set as new evidence.

## Alternatives

Reusing the development score costs less but measures selection on the same observations. A weighted aggregate alone can conceal regressions. Automatic promotion would combine experimental evidence with release authority. Those options are excluded.

Confirmation is separate from runContrastive so existing callers retain behavior and deployments can reserve different budgets and privileges for development and independent evaluation. A declared maximum cost is not a claim that two methods spent exactly equal dollars.

## Validation

Unit and adversarial tests cover successful paired confirmation, ties, forbidden regressions, insufficient evidence, overlapping task IDs, duplicate task IDs, scope and digest mismatch, invalid values, cancellation and reservation limits.

The public task experiment uses pinned CLINC150 human utterances and frozen development and test partitions. It reports provider costs and latency and compares a competent frozen baseline, the selected contrastive configuration and an independent prompt search control. The comparison plan requires contrastive versus baseline and contrastive versus independently selected control, with alpha 0.025 per comparison. Both must pass to support an improvement claim over both alternatives. Fresh confirmation predictions may be shared across the two comparisons, with costs counted once. No development execution cache is reused.

This is a small public-data pilot. It does not prove private transfer, resistance to training contamination or general coding performance.

## Rollback and remaining authority

Pin @metaharness/darwin to 0.11.0 to omit the new API. Existing evolve and runContrastive defaults do not change. The deployment owner controls secrets, execution isolation, heldout data custody, repeated-testing policy and production releases.
