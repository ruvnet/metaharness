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
