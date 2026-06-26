# Darwin Cascade (GLM-5.2 → Claude Opus 4.8) — SWE-bench Verified

**55.6% (278/500)** · Wilson 95% CI [51.2, 59.9] · **~$0.15/instance (estimated)** · conformant.

Submitted by **ruvnet** (rUv, ruv@ruv.net) — the open-source Metaharness / Darwin Mode harness:
**https://github.com/ruvnet/agent-harness-generator**

A cost-Pareto submission: the contribution is the **resolve-per-dollar at this tier**, not the absolute score.
Cheap GLM-5.2 ReAct base solves all 500 instances; only empty-patch give-ups (a 100%-precision escalation
signal) escalate to Claude-Opus-4.8 (167 escalations). ~56× cheaper than frontier-only systems at a comparable
resolve tier, and it confirms the same empty-patch-cascade method that scored 51.3% on SWE-bench Lite (PR #453)
generalizes to Verified — and lands higher (Verified is human-validated/cleaner).

## Files
- `all_preds.jsonl` — predictions (instance_id, model_name_or_path, model_patch)
- `results/results.json` — official `swebench` gold eval: 278 resolved / 500 total

## Result (official harness)
- **Total instances:** 500 · **Resolved:** 278 · **Resolve rate:** 55.6% · Wilson 95% CI [51.2, 59.9]
- By repo: django 133, sympy 40, scikit-learn 25, sphinx 21, matplotlib 16, xarray 16, pytest 11, astropy 8, …
- run_id `verified-500-cascade-local` (official `swebench` harness, gold eval, local Docker).

## Cost (estimated — see honest note)
~**$0.15/instance**: GLM-5.2 base on all 500 (~$0.018/inst) + Claude-Opus-4.8 on the 167 empty-patch escalations
(~$0.40/inst agentic). **Per-instance cost was not captured in the prediction records**, so this is a
methodology-based estimate, not a measured per-call total. (Cost is not the leaderboard metric; resolve is.) The
Lite submission (PR #453) carries a precisely-measured $0.267/instance.

## Conformance checklist
- [x] Is a pass@1 / Best@1 submission (single final prediction per instance; escalation is a deterministic
      empty-patch give-up signal, no test knowledge used to select)
- [x] Does **not** use SWE-bench test knowledge (`PASS_TO_PASS`, `FAIL_TO_PASS`) — solver sees only the repo's
      own tests during solving
- [x] Does **not** use the `hints` field
- [x] No web-browsing — the solver's tools are read/edit/run only; it structurally cannot look up solutions

## Method
Identical to the Lite submission — see the [technical report](./REPORT.md). The cascade exploits that an *empty
patch* from the cheap model is a 100%-precision "I give up" signal: escalate exactly those instances to the
frontier model, leaving the rest cheap. Replicated across both SWE-bench splits (Lite 51.3% / Verified 55.6%).
