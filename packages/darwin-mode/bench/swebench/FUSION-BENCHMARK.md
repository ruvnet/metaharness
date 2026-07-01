# Fusion-Sidekick Benchmark — the "we can also do Devin Fusion" proof (HONEST)

**ADR-222 prototype.** Reproduces Devin Fusion's two levers
([cognition.com/blog/devin-fusion](https://cognition.com/blog/devin-fusion)) inside the darwin
SWE-bench harness and benchmarks them **honestly** on a HARD slice.

- **Sidekick delegation** — a frontier "lead" agent keeps planning/decision/review authority and
  DELEGATES mechanical sub-tasks (wide greps, reading many files, applying a decided edit) to a
  cheap "sidekick" agent. Both are full ReAct agents on the same work tree.
- **Mid-session routing** — a lightweight heuristic classifier switches the lead's *working model*
  mid-trajectory: cheap by default for mechanical stretches, escalate to frontier on repeated
  test-fail or thrash, sticky for a cooldown window. (Devin does the switch at context-compaction to
  make it "free"; we switch per-step — the simplest honest analog.)

Devin's published claim: **35–41 % cost cut at frontier-level quality on hard coding tasks.**

> **Headline verdict: INCONCLUSIVE at N=8 — cannot be scored as a "cost-cut-at-equal-quality" win.**
> Fusion-mode was materially cheaper (**$0.42 vs $1.07 single-frontier, ~61 % cheaper**), but **every
> arm resolved 0/8 under the gold SWE-bench oracle.** A cost delta with *both* arms at zero gold-resolve
> is **not** equal-quality-at-lower-cost — you cannot claim equal quality when nothing is solved. This
> is a valid negative/inconclusive finding (like ruprompt's routing-for-quality null), reported straight.

---

## What was built

| File | Role |
|---|---|
| `fusion-loop.mjs` | Pure, dependency-injected Fusion ReAct core. `fusionSolve()` runs the lead loop with a `delegate` tool that spins the cheap **sidekick** as its own bounded `agenticSolve()` on the shared tree; `makeRouter()` is the mid-session model router. Reuses `agentic-loop.mjs` primitives (`makeTools`/`parseAction`/`agenticSolve`/`stateHash`). |
| `fusion-loop.test.mjs` | 7 unit tests, **mock LLM, $0** — delegation routes a mechanical step to the sidekick; router escalates on repeated test-fail / thrash and downgrades on mechanical stretches; the loop terminates + emits a patch; cost accounting sums main+sidekick correctly. All green. |
| `solve-fusion.mjs` | Wires the real fetchRepo / OpenRouter / Docker-oracle to `fusionSolve` (`--model` = frontier lead, `--sidekick-model` = cheap). Mirrors `solve-agentic.mjs`'s I/O, `--concurrency`, `--max-cost`, `--no-test-oracle` conformant mode. Records per-instance delegations, model-switches, hi/lo step split, and main-vs-sidekick cost. |
| `fusion-hard-slice.json` | The 8-instance hard slice (1 per repo, from `hard-25.json`). |

**Router policy (documented, non-ML):** first `leadSteps` (2) on the frontier for the opening plan;
cheap by default thereafter; escalate to frontier when `consecutiveTestFails ≥ 2` or on a **new**
thrash event (exact-repeat read/grep/ls); stay escalated for `cooldown` (3) steps, then relax.

---

## Method

- **Slice:** 8 hard instances, one per repo, from `hard-lite-ids.json` (the HARD set, not the easy
  pilot): `psf__requests-2674`, `pylint-dev__pylint-7114`, `pytest-dev__pytest-5103`,
  `sphinx-doc__sphinx-7738`, `pydata__xarray-3364`, `sympy__sympy-11870`, `django__django-11564`,
  `matplotlib__matplotlib-25079`. Instance eval images pre-pulled from Docker Hub.
- **Models (via OpenRouter):** frontier = `anthropic/claude-sonnet-5` ($2/$10 per M tok);
  cheap = `deepseek/deepseek-chat` (~$0.20/$0.80 per M tok, ~10–13× cheaper).
- **In-loop signal:** `--no-test-oracle` (conformant — the repo's OWN tests inside the instance
  image; the gold `FAIL_TO_PASS` is **never** seen during solving), maxSteps 12, concurrency 2.
- **Scoring:** every prediction file gold-scored with `swebench.harness.run_evaluation` (Docker,
  **$0**, no LLM) — the numbers below are the REAL resolve rate, not the conformant in-loop proxy.
- **Budget:** hard-capped per arm at `--max-cost 12` (total ≤ $36 < $40). No arm hit its cap.

---

## Arms table (gold-scored, N=8)

| Arm | Config | Gold resolved / 8 | Non-empty patches / 8 | Total $ | $/instance | $/resolved |
|---|---|:--:|:--:|:--:|:--:|:--:|
| **A — single frontier** | `claude-sonnet-5`, all steps | **0** | **0** | $1.073 | $0.134 | n/a — 0 resolved |
| **B — tier-cascade** | `deepseek` → escalate tail to `sonnet-5` (existing `--cascade`) | **0** | 5 | $1.184 | $0.148 | n/a — 0 resolved |
| **C — fusion** | `sonnet-5` lead + `deepseek` sidekick + mid-session routing | **0** | 5 | **$0.419** | **$0.052** | n/a — 0 resolved |

**Total LLM spend on the benchmark: $2.68** ($1.073 + $1.184 + $0.419 + $0.007 smoke). Gold scoring: $0.

### Fusion lever telemetry (arm C) — both levers demonstrably fire

- **Delegation:** 17 delegations across 8 instances (1 produced an actual edit; the rest were
  fact-gathering greps/reads the lead then reviewed). So the sidekick *was* used — it just rarely
  converted to a landed change on these hard bugs.
- **Mid-session routing:** 13 model-switches; **~60 % of lead steps ran on the cheap model**
  (main-model cost $0.39, sidekick $0.03 — sidekick was only **6.8 %** of spend; the routed-cheap
  *lead* steps are what drove most of the saving).

---

## The confound that dominates the result (report this loudly)

**Arm A — the "pay-for-frontier" baseline — emitted 8/8 EMPTY patches.** `claude-sonnet-5` does not
reliably produce this harness's rigid "exactly one single-line JSON tool-call per turn" protocol, so
its edits never land and it never submits with a diff. Its $1.07 bought **nothing**. This reproduces
the documented **"custom harness under-scores the frontier model"** lesson (step-cap + tool-call-format
artifacts) — the frontier baseline never got a fair shot in this harness.

Consequently:

- Arms B and C produced 5/8 non-empty patches **because the CHEAP model (`deepseek`) does the actual
  editing** — deepseek satisfies the JSON protocol where sonnet-5 does not. On this harness, *adding a
  cheap model paradoxically increases patch-emission over pure frontier* (0 → 5 of 8).
- So fusion's cheapness here is real but its cause is not the Devin story ("frontier plans, sidekick
  executes bulk"). It's: the routed/sidekick cheap model is the only component emitting valid patches,
  and it's cheap. The frontier "lead" contributed mostly empty turns.

---

## Verdict

**Did fusion-mode achieve a Devin-Fusion-class cost-cut-at-equal-quality on hard tasks? — NO / INCONCLUSIVE at N=8.**

- **Cost cut: yes, and larger than Devin's 35–41 %** (fusion is ~61 % cheaper than single-frontier,
  ~65 % cheaper than cascade).
- **Equal quality: cannot be claimed.** All three arms gold-resolve **0/8**. "Equal quality" here means
  "equally zero" — that is not the Devin claim. You cannot demonstrate quality-preserving cost savings
  when no arm preserves any quality above zero.
- **Both fusion levers work mechanically** (17 delegations, 13 switches, 60 % steps on cheap) — the
  prototype is faithful — but neither lever converted to a single gold resolve on this hard slice.
- **The frontier baseline is confounded** by the tool-call-format artifact (0 valid patches), so even
  the cost comparison is not apples-to-apples: arm A paid frontier rates to emit nothing.

This is the same shape of honest negative as ruprompt's routing-for-quality null: the lever is real and
cheap to run, but there is **no evidence here that it buys frontier-level quality at lower cost on hard
tasks** — because in this harness, on this slice, *no* configuration reaches frontier-level quality.

## Implication for meta-llm ADR-222 strategy

1. **Do not bank a Fusion-class "cost-cut-at-equal-quality" claim from this run.** The cost delta is
   real but the equal-quality half is unproven (0/8 everywhere).
2. **Fix the harness before re-testing the lever.** The dominant signal is the harness penalizing the
   frontier model's tool-call format. A fair Fusion test needs a tool-**use** protocol the frontier
   reliably satisfies (native tool-calling API, not brittle single-line JSON), or a comparator harness
   with published frontier numbers — otherwise every "frontier is worse" result is a format artifact,
   not a capability signal.
3. **Then re-test on a regime where gold-resolve is non-zero** (larger N and/or an easier band), so
   "equal quality" is *measurable*. Only there can a 35–41 %-style claim be honestly confirmed or refuted.
4. **The routing lever is cheap and safe to ship as a cost lever** (it demonstrably runs most steps on
   the cheap model at $0.05/instance) — but ADR-222 should sell it as **"cost reduction on tasks the
   cheap model can already do"**, not as **"frontier quality at lower cost,"** until (2)+(3) prove the latter.

## Caveats

- **N=8, single seed** — high noise; a 0/8 vs 0/8 vs 0/8 result has no discriminating power on quality.
- Conformant in-loop signal (repo tests) is stricter/noisier than the gold `FAIL_TO_PASS`; all arms
  also showed 0/8 in-loop, consistent with the gold 0/8.
- `deepseek/deepseek-chat` and `claude-sonnet-5` are OpenRouter stand-ins for the "cheap" and
  "frontier" tiers; absolute numbers will shift with model choice.

## Reproduce

```bash
export OPENROUTER_API_KEY=$(cat /tmp/.orkey)
# unit tests ($0)
node --test --experimental-strip-types --no-warnings fusion-loop.test.mjs
# arm C (fusion) — the other two use solve-agentic.mjs --cascade / single --model
node --experimental-strip-types --no-warnings solve-fusion.mjs \
  --manifest fusion-hard-slice.json --model anthropic/claude-sonnet-5 \
  --sidekick-model deepseek/deepseek-chat --max-steps 12 --concurrency 2 \
  --max-cost 12 --no-test-oracle --out fusion-bench-C-fusion.jsonl \
  --report fusion-bench-C-fusion-report.json
# gold score (Docker, $0)
python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path fusion-bench-C-fusion.jsonl --instance_ids <8 ids> --run_id fusion_gold_C
```

Artifacts: `fusion-bench-{A,B,C}-*.jsonl` (predictions) and `*-report.json` (per-arm telemetry).
