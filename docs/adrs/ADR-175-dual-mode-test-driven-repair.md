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

### Epistemic vulnerability: the Goodhart trap (downstream feedback, #47)
Consumers evaluating these modes must account for their fundamentally different verification properties:
- **Test-Driven Repair (oracle-ON):** the contract is independent of the agent. The fix is objectively
  verified against the user's ground-truth expectations.
- **Conformant Repair (oracle-OFF):** the contract *is* the agent. Because the agent authors the
  `reproduce_bug.py`, it is subject to Goodhart's Law — it may write a test with narrower scope, weaker
  assertions, or friendlier inputs than the ticket demands. A "pass" in Conformant mode only proves the
  agent satisfied *its own interpretation* of the bug, and requires human sanity-checking before the
  patch can be trusted in production.

Direction matters: for the **benchmark**, a gamed self-repro can only *lower* the gold `FAIL_TO_PASS`
score (it can't inflate a leaderboard number); for **product use with no ground truth there is no such
backstop** — hence the `--pause-for-test-review` mode below. Partial mitigation today (ADR-174
Test-Critic): the repro is validated to *fail on the unmodified code*, and the failure must be a real
assertion/exception (not an ImportError/collection error). Toward "assert the issue's *specific*
symptom": `test-critic.symptomBindingScore` now computes a **non-gating** confidence that the repro's
failure binds to the issue (does the trace raise an exception *type* the issue names? does the repro
reference the issue's salient identifiers?), recorded per-instance (`row.symptomBinding`). It is
deliberately **not** a gate — hard-rejecting low-binding repros risks lowering the load-bearing
conformant resolve, so we ship the *measurement* first; a gate is a follow-up decision that a live
A/B on the frozen holdout can now inform.

## Consequences
- Product default = oracle-ON (TDR). Leaderboard/no-test = oracle-OFF. Both documented in the darwin
  README + LEARNINGS §9.
- Reporting rule: always state which mode produced a number. Leaderboard claims come only from
  oracle-OFF, batch-verified, conformance-asserted runs (ADR-173/174 gates).

## Third mode (#47): `--no-test-oracle --pause-for-test-review`
Conformant + **mandatory human-in-the-loop review of the agent-written test** before the fix is trusted
— preserving Conformant's no-test reach without its blind-trust weakness. Fully-unattended Conformant
(Legacy Modernizer batch) stays as-is for users who accept the trade-off. Status: accepted as a planned
mode; ruflo offered a PR. Reporting honesty unchanged: a Conformant "pass" is always labeled as
*agent-test-verified*, never equated with a ground-truth resolve.
