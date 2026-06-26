# Darwin Cascade on SWE-bench Verified — a cost-Pareto technical report

**ruvnet (rUv)** · ruv@ruv.net · https://github.com/ruvnet
Harness: **Metaharness / Darwin Mode** (open source) — https://github.com/ruvnet/agent-harness-generator

**Result: 55.6% (278/500) on SWE-bench Verified, Wilson 95% CI [51.2, 59.9], ~$0.15/instance (estimated), conformant.**

## TL;DR — the contribution is resolve-per-dollar, not peak resolve
This is deliberately **not** a SOTA-resolve claim. Frontier-only agents reach 70-79% on Verified at $3-15+/instance.
Our claim is the **cost-Pareto frontier**: ~55.6% at an estimated ~$0.15/instance — roughly **56× cheaper** than
frontier-only systems at a comparable resolve tier. It also demonstrates that one cheap, simple mechanism generalizes:
the **empty-patch cascade** scored 51.3% on SWE-bench Lite (submission PR #453) and **lands higher here on Verified**.

## The method: the empty patch is a 100%-precision escalation signal
1. **Cheap base on everything.** A GLM-5.2 ReAct agent (read / edit / run tools; no web; no test knowledge) attempts
   all 500 instances at a modest turn budget.
2. **Escalate only the give-ups.** When the cheap model emits an **empty patch**, that is a *deterministic,
   100%-precision* "I could not solve this" signal — no test execution or oracle needed to detect it. Exactly those
   instances (167 of 500 here) escalate to a single Claude-Opus-4.8 attempt. Everything else stays cheap.
3. **One final prediction per instance** (pass@1 / Best@1). The escalation decision uses *only* the presence/absence
   of a patch, never `PASS_TO_PASS` / `FAIL_TO_PASS` / `hints`.

This is the cheapest way we found to break the cheap-model resolve ceiling: you pay the frontier tax on only the ~33%
of instances the cheap model gives up on, and the give-up signal costs nothing to compute.

## Why Verified lands higher than Lite (55.6% vs 51.3%)
SWE-bench Verified is human-validated — it removes the broken/underspecified instances that depress Lite. The cascade
benefits from the cleaner distribution: the same mechanism, a higher ceiling. Empty rate was comparable (~33% on both),
confirming the escalation signal is stable across splits.

## Conformance
The solver never sees the grading tests during solving — it uses only the repository's own tests as an in-loop signal,
and the escalation gate keys solely on whether a patch was produced. No `PASS_TO_PASS`, no `FAIL_TO_PASS`, no `hints`,
no web access (the agent's tool surface is read/edit/run only). pass@1 / Best@1: one prediction per instance.

## What we explored and ruled out (honest negative space)
The Metaharness research arc (LEARNINGS §28-§49) tested and *rejected* a series of would-be improvements, conformantly:
- **Selection** (Best-of-N judge, xcascade, reproduction-test selection) — no lift over the simple cascade (§35/§44).
- **Localization** pre-seeding (AST mincut) — not the bottleneck; the ReAct loop self-localizes (§38).
- **Cheaper escalation tiers** (deepseek-r1, kimi-k2.6) — both underperform Opus on repo repair (§48).
- **Turn budget** (15→30 steps) — no lift on Lite; the cheap base saturates (§49).

The conclusion: for this cheap-conformant approach, **candidate generation is the wall**, and **GLM→Opus at a modest
turn budget is the cost-Pareto optimum**. Higher resolve requires either frontier spend (off our thesis) or a different
agent architecture.

## Reproducibility & honesty notes
- Official `swebench` harness gold eval (run_id `verified-500-cascade-local`); `results/results.json` carries the
  278 resolved instance IDs.
- **Cost is an estimate** (~$0.15/inst): GLM base ×500 + Opus ×167 escalations; per-instance cost was not captured in
  the prediction records. The Lite submission (PR #453) carries a precisely-measured $0.267/instance.
- All numbers are real, gold-graded, conformant. The harness is fully open source for inspection and replication.

## Cost-Pareto leaderboard
Live, interactive: https://ruvnet.github.io/agent-harness-generator/cost-pareto.html
