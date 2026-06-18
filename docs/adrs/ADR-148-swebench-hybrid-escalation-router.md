# ADR-148: SWE-bench hybrid cheap→frontier escalation ("Barbarian and the Scholar")

**Status**: Proposed (design; measurable — gated on the ADR-149 repair-300 hard-tail)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-143 (repair loop), ADR-146 (emission wall), ADR-145 (learned router), ADR-144 (7.7% baseline)

> The cheap model (`deepseek-chat`) has a **reasoning ceiling**: even with the exact pytest traceback, some bugs exceed its capacity to synthesize correct logic. Hardwiring a frontier model everywhere is economically absurd ($2–8/instance × 300 ≈ $600–2400/run, destroying the evolutionary premise). This ADR specifies the middle path: run the cheap model first, **escalate only the failures** to a frontier model. "Barbarian and the Scholar."

## Design

A failure-triggered escalation wrapper around the existing repair loop (`solve-repair.mjs`):

1. **Barbarian (cheap):** `deepseek-chat` + localize + repair loop (≤3 attempts, Docker test feedback) — the validated ADR-143/146 pipeline. Banks the bugs it can solve at ~$0.02–0.05 each.
2. **Escalate on tap-out:** when the cheap loop returns `resolved=false` after its attempts, mark the instance "hard tail" and re-run it with a **frontier model** (`gpt-5-mini` or a `claude`/`gpt-5` tier), passing the accumulated failing tracebacks: *"the cheap model couldn't fix this; here's what failed; you have N attempts."*
3. **Blended cost** stays near the floor: the cheap model handles the bulk volume; the frontier model only touches the unresolved minority.

This is **simpler than ADR-145's learned router** — no training labels, no embedding model; escalation is triggered by a *measured* repair-loop failure, not a predicted one. ADR-145 (predictive routing) is the optimization *after* this reactive version is validated.

## Honest scope — what is and isn't claimed

- **The 70–85% "SOTA tier" projection is a HYPOTHESIS, not a result.** It will not be claimed until measured. Today's *measured* numbers are: deepseek baseline **7.7%**, +localize **8.0%**, repair-loop-300 **pending (ADR-149)**. Frontier-model lift in this exact harness is **unmeasured**.
- The plausible mechanism (frontier models clear the emission wall + spend attempts on logic not syntax) is sound but **must be measured**, including the real per-instance frontier cost in *this* loop (context grows with each repair turn).
- Leaderboard leaders' 65–88% use heavy frontier scaffolding; a hybrid floor-anchored number that lands materially above 8% at <$1/instance blended is the **cost-adjusted** result worth claiming — and only with a Wilson CI.

## Measurable experiment (the deliverable)

Once ADR-149 (repair-300) defines the **deepseek hard tail** (the unresolved instances that *did* get the right file selected — the emission/reasoning failures), run **one frontier-escalation pass on that hard tail** (a bounded subset, not all 300) and measure:

- **resolve-rate lift** on the hard tail (how many the frontier model recovers),
- **actual blended cost/instance** (cheap volume + frontier tail),
- projected full-benchmark resolve-rate = banked-cheap + frontier-recovered, with CI.

Budget: the hard tail is ~the unresolved set; even at $2–8/frontier-instance, a ~100-instance tail pass is ~$200–800 — so this runs on a **bounded sample** of the hard tail within the $250 budget, or `gpt-5-mini` (cheaper) over the full tail.

## Consequences

- A reactive escalation wrapper is the next build after ADR-149; it reuses `solve-repair.mjs` with a `--escalate-model` flag.
- Phase 3 ("lights-out"): once Barbarian+Scholar+localize are validated, Darwin Mode evolves the knobs (k, maxAttempts, escalation threshold, model tiers) against the real SWE-bench fitness (ADR-130 wired to this pipeline).
- This ADR records the design + the honest boundary so a later loop executes it without re-deriving — and without over-claiming.

## Status note

Proposed. Gated on ADR-149 (repair-300 result + hard-tail extraction). No frontier/leaderboard number claimed until the escalation pass is measured.
