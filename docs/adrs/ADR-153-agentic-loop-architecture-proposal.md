# ADR-153: Beyond escalation — the agentic-loop architecture for the 65–88% tier

**Status**: Implemented + first empirical number (pilot-25 = 36%, ADR-153); full-300 is the decisive next test
**Date**: 2026-06-19
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-149/151/152 (the 7.7→40.3% ladder), ADR-148 (tiering), issue #39

## Why now

The single-shot-localize + search/replace + repair + tiered-escalation paradigm has been pushed to a
measured **40.3%** on SWE-bench Lite (ADR-152), via two compounding levers:

| lever | rate |
|---|---|
| baseline | 7.7% |
| closed-loop repair | 15.3% |
| stronger cheap base (v4-pro) | 29.3% |
| + frontier-tail Scholar | 33.3% → **40.3%** (v4-pro base) |

The remaining levers within this paradigm are now low-ROI: a 3rd frontier tier (Sage, ADR-152
follow-up) attacks an ever-harder residual at steeply rising $/resolve; router (ADR-145) and knob
evolution are cost optimizations, not resolve-rate. **The gap from 40.3% to the 65–88% agentic-SOTA
tier is architectural, not a tuning gap.**

## The structural limitation

Every solver in this arc is **single-turn-per-attempt**: localize → emit a patch → (repair) re-emit.
It never *explores*. The instances it fails share a signature: the fix requires **discovering**
context the lexical/LLM localizer can't surface in one shot — reading call sites, running a failing
test to see the actual stack, grep-ing for a helper, checking a sibling module's convention. SOTA
agents (the 65–88% systems) are **multi-step autonomous loops** with a real tool surface.

## Proposal: an agentic execution loop as a new sandbox mode

Add `--sandbox agentic` (alongside `real`/`mock`/`agent`) — a bounded ReAct-style loop where the model
drives, per step, a **restricted tool surface inside the existing safety gate**:

- `read(path, range)` · `grep(pattern)` · `ls(dir)` — repo navigation (read-only)
- `run_tests(ids)` — execute FAIL_TO_PASS in the instance's Docker image, return the real trace
- `edit(search, replace)` — the current search/replace primitive (already validated)
- `submit()` — finalize the diff

Bounded by: max steps (e.g. 20), max tokens, wall-clock, and the **same `validateGeneratedCode`
safety gate** (no new imports/network/shell/secret access in emitted edits). Darwin's 7 mutation
surfaces become the *policy* the loop evolves: `planner` = step strategy, `toolPolicy` = tool
ordering/budget, `contextBuilder` = what to read next, `retryPolicy` = when to re-test vs re-read.

## Why this is the right next investment

1. It targets the *measured* failure mode (can't-discover, not can't-emit) — §9's emission wall was
   climbed by repair; the residual is a **discovery** wall.
2. It reuses everything proven: search/replace primitive, Docker test oracle, safety gate, the
   tiered cheap→frontier routing (run the agentic loop on a cheap base, escalate hard cases).
3. It keeps the project's thesis intact: **the harness (now an agentic loop) is the lever**; evolve
   the loop's policies, keep the model swappable.

## Honest expectation

Agentic loops are where the 65–88% numbers live, but they cost more tokens/instance (multi-step) and
add failure modes (loops, tool-thrash, context blow-up) the single-shot paradigm doesn't have. The
deliverable of this ADR is the *architecture + safety envelope*; the empirical number is the next arc.

## Status of the current paradigm

Frozen at **40.3%** (ADR-152) as the cheap-base + tiered-escalation ceiling. Further escalation tiers
are recorded but yield diminishing pp at rising cost. The resolve-rate frontier now moves to this
agentic architecture.

## Implementation (2026-06-20)

The architecture above is now code, with the loop logic separated from I/O so it is unit-testable
offline (no network/Docker):

- **`packages/darwin-mode/bench/swebench/agentic-loop.mjs`** — the pure, dependency-injected core:
  `AGENTIC_SYSTEM` (the tool protocol prompt), `parseAction` (tolerant single-action JSON parser),
  `makeTools` (the dispatcher: `ls`/`read`/`grep`/`edit`/`run_tests`/`submit` over an injected I/O
  surface, with the safety guards — never edit test files, no path traversal, non-matching SEARCH
  reports instead of corrupting), and `agenticSolve` (the bounded ReAct loop, `maxSteps` budget,
  returns the final working-tree diff).
- **`packages/darwin-mode/bench/swebench/solve-agentic.mjs`** — the CLI runner wiring the real
  `fetchRepo`/`llm`/`evalOne`/git to the core (mirrors `solve-repair.mjs`: same flags, concurrency,
  fetch-retry, per-instance cleanup; `--max-steps`, `--base-url` for local/$0 endpoints).
- **`packages/darwin-mode/__tests__/agentic-loop.test.ts`** — 12 offline tests: a scripted model
  drives the dispatcher over a real temp git repo (explore → edit → run_tests → submit → fix patch),
  plus the safety guards and the messy-output parser. Part of the passing suite (366 tests).

What remains is the **empirical at-scale run** (`solve-agentic.mjs` over full-300 → official batch
eval), which is the deferred budget step — the current $500 is effectively spent ($486.52/$500). The
loop runs $0 against a local endpoint (`--base-url http://localhost:11434/v1`), but the local 14b's
capability floor (RESULTS §18: empty-diff rate) makes it a poor first probe of agentic gains; the
meaningful number wants a capable base and is the next arc's first experiment.
