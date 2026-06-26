# ADR-194 — Crack-the-tail: per-instance parallel evolution → generalizable capabilities → conformant validation

**Status:** Proposed (per-instance evolution harness in flight)
**Date:** 2026-06-26
**Related:** ADR-153 (agentic-loop architecture for the 65-88% tier), ADR-176 (SWE Conductor — role-specialized localize/repro/fix/review), ADR-184/187/188 (Darwin genome evolution), LEARNINGS §44 (candidate-generation is the wall), §49 (cheap frontier mapped), §50 (Opus uniquely best single tier; only BoN beats it), the HARD-25 discriminator (`hard-lite-ids.json`, the 25 Opus-give-ups).

---

## Context

The cheap-conformant cost-Pareto frontier is fully mapped (§49): GLM→Opus cascade = 51.3% Lite / 55.6% Verified is the optimum for that approach. Selection/localization levers are exhausted (§44); no cheaper escalation tier matches Opus (§50). The only lever that beats single-Opus is **test-time compute** (BoN+judge: `xbo:opus+glm` 18/25 on the regular-25 vs 16/25 single).

But on the **HARD-25** — the instances where even single-Opus could not produce *any* patch (`no_generation`) — frontier test-time compute barely helps: early multi-model BoN runs crack only **1-3 of 25**. Brute compute is not the answer; these instances fail for **specific reasons** (localization across large repos, inability to reproduce the bug, turn-budget exhaustion, missing tooling, or genuine under-specification). Breaking SOTA requires **failure-mode-driven harness capabilities**, added incrementally and verified on exactly the instances that need them.

## Decision

Adopt a **crack-the-tail program**: parallel **per-instance Darwin evolution** as a *diagnosis engine*, feeding a *generalizable capability set*, validated by a *conformant held-out claim*.

### 1. Per-instance evolution (the research engine)
For each hard instance, run a tiny Darwin config-evolution over a **capability genome** (localization mode, reproduction-gate, reviewer/critic loop, turn budget, model, BoN width), fitness = **k-sample resolve on that single instance** (k≥2 to beat binary noise). Parallelized across the hard set, cost/quota-bounded (ADR-072 breakers). Output: a **coverage map** — for each instance, whether it is crackable and by *which capability*.

### 2. Generalizable capability set (the product)
Aggregate the coverage map into the capability *set* that maximizes coverage. Distinguish capabilities that are already config-toggleable from those needing **new harness code** (e.g. repo-map/AST localization per ADR-176, a reproduction-first gate, a reviewer sub-agent) — that ordering is the build roadmap toward the ADR-153 tier.

### 3. Conformant held-out validation (the claim) — THE FIREWALL
**Per-instance evolution against the gold test is TUNING ON THE TEST = non-conformant (HV-1).** Per-instance results are **diagnosis only, never a leaderboard claim.** Any SOTA claim must come from **ONE harness** (or a conformant router that selects config *without* gold tests), validated on **held-out instances / n=300 with zero per-instance gold tuning**. The genome encodes only *general* capabilities, never instance-specific hacks.

## Consequences
- A disciplined, incremental path to the 65-88% tier (ADR-153): diagnose → build the capability → re-crack the batch → accumulate → validate held-out.
- **Honest ceiling:** some Opus-give-ups are genuinely under-specified or have non-unique gold patches (cf. UTBoost ~40% false-positive rate on leaderboard entries). The hard-25 ceiling is below 25/25; recognizing the uncrackable set is part of the result, not a failure.
- The per-instance evolution is reusable for any future hard set (Verified, Multilingual).
- Cost-bounded research: tiny per-instance searches are cheap; only the held-out n=300 validation is expensive, and it gates the claim.
