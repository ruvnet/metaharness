# ADR-170: Transition from `searchreplace` to a stateful PTY agent loop

**Status**: Proposed (blueprint; implementation + batch-validation are the next arc)
**Date**: 2026-06-21
**Project**: `ruvnet/agent-harness-generator`
**Supersedes/extends**: ADR-153 (the bounded ReAct agentic loop already shipped:
`bench/swebench/agentic-loop.mjs` + `solve-agentic.mjs`, tools read/grep/ls/edit/run_tests/submit).
**Related**: ADR-144–150 (the closed-loop repair arc), ADR-154 (58.3% 3-tier), ADR-169 (patch memory).

> **Numbering note.** Authored as "ADR-151" in the proposal, but ADR-151 is already in use
> (`ADR-151-v4pro-cheap-floor.md`, the v4-pro floor result) and the repo convention is `docs/adrs/`
> (not `docs/decisions/`). Renumbered to **ADR-170** to preserve the ADR log; content is otherwise the
> authored blueprint, reconciled with the fact that a first-generation agentic loop already exists
> (ADR-153) — this ADR is the **PTY/bash upgrade** to it, not a from-scratch first step.

## 1. Context and Problem Statement

Our Darwin Mode arc relies on a `searchreplace` formatting primitive: given localized files, an issue,
and a test traceback, the model emits a single perfectly-formatted edit block. ADR-144–150 proved a
closed-loop `pytest` feedback harness ~doubles baseline performance, and ADR-151 proved a stronger
cheap base (deepseek-v4-pro) lifts the floor again. ADR-153 took the next step — a bounded ReAct loop
(read/grep/ls/edit/run_tests/submit) — measured at 31.3% on v4-pro (competitive + ~3× cheaper than
single-shot). The cheap-base + 3-tier escalation peak is **58.3%** (ADR-154).

The remaining gap to the 2026 SOTA band — externally reported around **~60% on SWE-bench Pro** and
**80%+ on SWE-bench Verified** with frameworks like `mini-SWE-agent` / `Live-SWE-agent` (note: those
are Pro/Verified; our 58.3% is **Lite** — not directly comparable) — is the **interaction primitive**,
not model IQ. Forcing the model to hold 4 interconnected files in context and emit the whole fix in one
shot (even the ADR-153 search/replace `edit`) is an unnatural constraint. SOTA agents instead drive a
**stateful bash terminal** inside the container: explore (`grep`/`cat`), edit by line range, run
`pytest` themselves, read the traceback, and self-correct before submitting.

## 2. Decision

Deprecate single-shot `searchreplace` as the primary edit primitive in favor of a **stateful PTY
(pseudo-terminal) agent loop**. The orchestrator stops parsing markdown patches and becomes a routing
bridge between the LLM and a persistent bash session inside the SWE-bench testbed container.

### 2.1 ReAct tool schema (4 primitives — small surface to curb hallucinated loops)
1. `execute_bash(command)` — any bash (`grep -rn`, `pytest tests/…`, `ls -la`); returns stdout/stderr.
2. `read_file(path, start_line, end_line)` — numbered chunks, no full-repo context dump.
3. `edit_file(path, start_line, end_line, content)` — replace a specific line range.
4. `finish_task()` — signal the patch is ready for the official SWE-bench eval.

### 2.2 Trajectory + context management
- **Max turns:** 50 environment turns/instance (budget-runaway guard). Reuse the ADR-169 E4
  **state-hash anti-thrash** (repeat read/grep → warning) — already shipped — at this longer horizon.
- **Terminal binding:** persistent PTY to the testbed container (stateful `cd`, env vars).
- **Scratchpad / trajectory memory:** every turn opens with a `thought` block — what the last
  execution taught + the next intent — carried across the context window.

## 3. Rationale
- **Matches SOTA mechanics.** Real developers (and the leaderboard frameworks) grep, run partial
  tests, and explore before editing. A PTY aligns us with that.
- **Shatters the emission wall.** A 3-line JSON tool call to edit 5 lines is far more reliable than a
  200-line markdown block; indentation/escaping errors drop to ~zero.
- **Leverages high-context cheap models.** v4-pro (~$0.05/inst, 1M-token context) can run a 50-turn
  session and ingest full test stdout without truncation.

## 4. Consequences
- **Positive:** unlocks multi-file refactors; pushes the resolve-rate ceiling toward 60%+.
- **Negative:** wall-clock per instance rises (~2min → ~15min); failure modes (tool-thrash, context
  blow-up) the single-shot loop lacks — mitigated by the ADR-169 anti-thrash + the 50-turn cap.
- **Economic:** higher per-instance cost from 50-turn context accumulation → mandates cost-optimized
  frontier engines (v4-pro / gpt-5-mini), not heavy legacy models, as the loop driver.

## 5. Validation gate (our discipline)
This is **Proposed**, not adopted. Before deprecating `searchreplace`: implement the PTY loop, run it
on full-300, and **batch-verify it beats the current best comparable number** (the ADR-153 agentic
31.3% on the same base, and ultimately the 58.3% blended ceiling). Only batch-eval numbers are
authoritative; in-loop drifts 1.5–5×. Sequence after the in-flight E1 (full-300 agentic baseline) and
the Phase-2 E4/E3/E5 plan (ADR-169 / research report) land their batch numbers.

## 6. Trajectory & ceilings (projected — roadmap, NOT measured)

Where this paradigm maxes out, so we invest with eyes open. **These are projections informed by
external SOTA + reasoning, not our batch numbers — held to the same "measure before claiming" rule.**

1. **PTY ceiling ≈ 65–75%.** A stateful single-threaded bash agent reliably reaches the 60%+ tier but
   likely hard-stops ~70–75%. Failure mode: **contextual collapse / tool-thrash** — ~turn 35, after a
   dozen greps / file reads / failed pytests, attention degrades; the agent forgets *why* it changed
   the base class and starts hallucinating local fixes that break downstream deps. ADR-169's state-hash
   anti-thrash + the 50-turn cap blunt this but don't remove it (they bound *repetition*, not *drift*).

2. **Past 75% needs search-over-execution (MCTS).** Stop treating the LLM as one developer typing;
   treat it as a **search algorithm**. On a hard bug, fork the container state into N parallel PTY
   branches (e.g. schema change vs UI patch vs parser fix), run each loop, score by test outcome, prune
   losers, compound winners. Pushes toward 80%+ — but converts inference cost from **pennies to dollars
   per instance** (the cost-per-resolve objective must gate how often forking is triggered — likely
   only on the difficulty-router's high-uncertainty tail, ADR-169 E2).

3. **The absolute limit — Maintainer, not Architect.** Every variant here (single-shot, PTY, MCTS
   swarm) is an **optimizer over an existing graph**, not an **originator**. Given a 100k-line codebase
   with established patterns + a failing test, the agent traverses, isolates, and synthesizes a fix
   (the Maintainer — where it excels). Asked to invent a novel architecture / abstractions from zero,
   it returns generic boilerplate (the Architect — where it fails; the "zero-to-one" spatial reasoning
   isn't in the weights). **We can automate the maintenance lifecycle to ~85% by brute-forcing parallel
   PTY containers; we are building the ultimate Senior Staff Maintainer, not the CTO.** SWE-bench
   measures exactly the Maintainer task — which is *why* it is tractable, and why a high score on it is
   not a claim about origination.

**Implication for sequencing:** ADR-170 (PTY) is the next ceiling-raiser; an MCTS layer is the one
after, gated hard on cost-per-resolve (fork only the tail). Neither changes the qualitative limit in
(3) — so the durable product framing is "autonomous maintainer," not "autonomous architect."
