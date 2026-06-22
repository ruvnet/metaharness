# ADR-175: Dual-mode repair — Test-Driven Repair (oracle-ON) vs Conformant autonomous repair (oracle-OFF)

**Status**: Accepted
**Date**: 2026-06-22
**Project**: `ruvnet/agent-harness-generator`
**Builds on**: ADR-173 (conformant leaderboard path), ADR-174 (Test-Critic + MCTS). Formalizes the
distinction surfaced in LEARNINGS §9.

## Context

Darwin's SWE-bench ladder (→ 68.3%, RESULTS §30) gates repair/escalation on the official `FAIL_TO_PASS`
tests run **in-loop**. That is invalid for the *leaderboard* (held-out grader) but is precisely how a
human staff engineer works when handed a bug with a reproducing CI failure. The two regimes are
different products, not a hack vs a fix.

## Decision

Treat both as **first-class, flag-toggled modes** (`--no-test-oracle`), routed by a single question:
**does the caller already have a reproducing test?**

```
                 Bug / issue ingestion
                          │
              Has a user/CI failing test?
                ┌─────────┴─────────┐
              YES                   NO
                ▼                    ▼
        Oracle-ON (TDR)      Oracle-OFF (Conformant)
        • gate on the        • Test-Critic writes a
          caller's test        validated reproduce_bug.py
        • direct optimize    • MCTS searches k patches,
        • measured 68.3%       repro-gated select (ADR-174)
```

- **Oracle-ON — Test-Driven Repair (default for product use).** The caller's own acceptance/regression
  test is the reward signal. Legitimate, highest-performance; the **CI Autofixer** play: a failing test
  lands on a branch → Darwin opens a verified-fix PR for pennies. Measured ceiling-with-a-test: **68.3%**.
- **Oracle-OFF — Conformant autonomous repair (`--no-test-oracle`).** No grading test in-loop; the
  Test-Critic authors a valid failing repro, then MCTS finds the fix. The **Legacy Modernizer** play
  (vague ticket, no test) — and the leaderboard-submittable variant.

## Rationale
- **Capabilities are additive, not substitutive.** The leaderboard (oracle-OFF) work *adds* the
  no-test-given capability; it doesn't replace TDR. Winning the harder zero-knowledge variant means the
  engine dominates when given real tests.
- **Protects the numbers.** 68.3% is a valid *product* claim (TDR), explicitly NOT a leaderboard entry.
  Pinning the two modes prevents future misreads by developers/investors doing a pure SWE-bench compare.
- One flag, one codepath difference (the in-loop signal source) — cheap to maintain both.

## Consequences
- Product default = oracle-ON (TDR). Leaderboard/no-test = oracle-OFF. Both documented in the darwin
  README + LEARNINGS §9.
- Reporting rule: always state which mode produced a number. Leaderboard claims come only from
  oracle-OFF, batch-verified, conformance-asserted runs (ADR-173/174 gates).
