# ADR-098: Darwin Mode — external-benchmark targeting strategy (SWE-bench / robustness race)

**Status**: Proposed (FUTURE — deferred, not yet implemented)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-076 (bench layer), ADR-090 (risk budget), ADR-094 (clade), ADR-096 (FDR), ADR-097 (curriculum)

> Captured at the user's request ("add adr and do later in the loops"). This is a **strategy/roadmap** ADR — a deferred plan, not a shipped capability. It records HOW Darwin Mode would target public agentic benchmarks so a later loop can execute it without re-deriving the approach. Nothing here is implemented yet; do not claim benchmark results until a real run exists.

## Context

Frontier models (Claude Fable 5, GPT-5.4-class) win static public benchmarks on scale + inference-time reasoning. Darwin Mode cannot out-scale them. Its differentiator is **robustness on out-of-distribution, long-horizon, multi-file work** and an **auditable, statistically-gated, recursive lineage** — a scientific product with provenance, not a black box.

## Decision (deferred plan)

When a future loop targets external benchmarks, do it in this order:

1. **Validation Harness first (de-risk before the real test).** Build a synthetic ~50-file repository stress-test that exercises context management and sustained architectural consistency over 50+ sequential steps — the regime where agents "lose the thread". Verify Darwin's loop holds state before exposing it to a real benchmark. *(Recommended starting point — cheaper and faster than the full set.)*
2. **`BenchmarkRunner` adapter.** Conform the harness to a standard runner contract (e.g. SWE-bench Verified task format: a repo + a failing test + the patch target) so results are apples-to-apples. Each task maps onto a `BenchmarkTask` (ADR-076) with real public/hidden/regression commands.
3. **Target SWE-bench Verified** as the primary "agentic-ness" benchmark (multi-file repo modification — where Poincaré steering + clade metaproductivity should shine). Use the curriculum (ADR-097) to ladder from single-file to multi-file tasks.
4. **Statistical provenance as the headline.** Log the bootstrap **p-value** (ADR-096) of every solve. The SOTA-beating signal is not a raw score but: "Darwin solved issue X with a statistically-real, FDR-controlled, reproducible lineage, and here is the audit trail" — robustness + provenance, not a leaderboard sprint.

## Honest constraints (why it is deferred)

- Requires real benchmark datasets + toolchains not present in the current environment, and substantial sandbox/runner work.
- Data-contamination claims about public sets must be verified, not asserted.
- No benchmark numbers may be reported until a real, reproducible run exists — the project's standing rule (no fabrication).

## Consequences

- A later loop can pick this up directly: build the validation harness → adapter → SWE-bench Verified subset → report with p-values.
- Until then, this ADR is a signpost only; the shipped system (ADR-070…097) stands on its own as an auditable evolutionary engine.

## Status note

Deferred by design. Revisit when the loop has bandwidth for benchmark integration and a target dataset is available. Start with step 1 (the synthetic 50-file validation harness).
