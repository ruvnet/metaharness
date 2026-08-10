# ADR-178 — Best-of-N selection via env-filter + LLM-judge discriminator

**Status**: Accepted (implemented: `bench/swebench/discriminator.mjs`)
**Date:** 2026-06-23
**Related:** ADR-174 (MCTS dead-end), LEARNINGS §13–17

## Context

The stateful interactive ReAct loop (conformant, repo's-own-tests as the regression gate) broke the MCTS
Goodhart ceiling — single trajectory = **34.0% [28.9, 39.5]** on full-300 SWE-bench Lite @ ~$0.005/inst.
N independent trajectories raise the *union* (any-of-N resolves) to ~60% on a pilot, but capturing that
headroom requires **selecting the right patch without the gold tests** (leaderboard-legal). Naive heuristics
(clean-exit) regress to ~single-traj.

## Decision

Two-signal conformant selector over N independent trajectories:

1. **Signal A — environment filter:** run the changed module's *specific* existing test file
   (`test_<mod>.py`, NOT the whole package suite — see the load-180 incident, §) in Docker; prune candidates
   whose tests **ran and failed**. Keep "nosignal" (couldn't run) candidates — abstain, don't penalize.
2. **Signal C — LLM judge:** if >1 candidate survives, an LLM picks the patch most likely to fix the issue
   (SWE-Search reports 73–84% selection accuracy). Default judge `deepseek/deepseek-v4-flash` (~$0.0002/inst).

Pilot (n=25): captured **13/15 union (87%)** → 52% @ ~$0.015/inst. The judge `fetch` MUST carry a timeout
(`AbortSignal.timeout`) — a hung call stalled the full-300 run at 142/300.

## Consequences

- A conformant, cheap Best-of-N selector — the lever from single-traj into top-tier resolve at pennies.
- Env-filter is Docker-bound and sequential; for full-300 the judge-only path (`--no-env-filter`) is the fast
  default, env-filter reserved for smaller sets. Future: parallelize env-filter.
- Selection quality is judge-bound; a stronger judge (Opus) is a measured future lever.
