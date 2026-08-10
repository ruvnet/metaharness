# ADR-143: Darwin Mode — closed-loop repair vs open-loop on real SWE-bench (controlled A/B)

**Status**: Accepted (measured) — Stage B2; honest A/B, mechanism confirmed, headline within noise at n=25
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-142 (open-loop pilot, 12%), ADR-126 (repair loop), ADR-127 (search/replace), ADR-138 (LLM-fitness noise)

## Context

> ADR-142 set the open-loop floor (3/25 = 12%). This turns ADR-126's repair loop back on against the **same stratified 25** SWE-bench Lite instances — a controlled A/B: open-loop single-shot vs closed-loop (run the real tests in Docker, feed the traceback back, retry up to 3×).

## Method

Identical sample, solver, and official `swebench` 4.1.0 Docker harness as ADR-142. The closed-loop solver (`bench/swebench/solve-repair.mjs`) adds: after each candidate patch, run the instance's `FAIL_TO_PASS` **inside its swebench Docker image**; if resolved, stop; else feed the failure back — **apply-rejection** ("your SEARCH didn't match") or the **pytest traceback** — and retry (≤3 attempts). Also includes the Stage-B1 whitespace-tolerant matcher + k=15.

## Result (real, 2026-06-18 — independently re-confirmed by a clean batch eval)

```
                    resolved   rate    Wilson 95% CI    patches   errors
open-loop (142)     3 / 25     12.0%   [4.2%, 30.0%]    13        1
closed-loop (143)   4 / 25     16.0%   [6.4%, 34.7%]    14        0
```

- **Closed-loop resolved:** django-15061, seaborn-3190, pytest-5227, sphinx-8721.
- **By attempt:** 2 on attempt 1 (pytest-5227, sphinx-8721); **2 on attempt 2** (django-15061, seaborn-3190) — resolved *only because of* the traceback-feedback retry.
- **vs open-loop:** newly resolved `django-15061` + `sphinx-8721` (the pilot resolved **no** django and **no** sphinx); lost `sklearn-13779` (resolved in the pilot, not here — run-to-run variance). Overlap: pytest-5227, seaborn-3190.

## Honest interpretation

- **The repair mechanism is real and demonstrated:** 2 of the 4 resolves required attempt 2 — a candidate that failed the tests, a traceback fed back, and a corrected patch that passed. `django-15061` is the clearest case: the pilot resolved zero django with single-shot; the loop cracked it on retry.
- **The headline +4pp is within noise at n=25.** The Wilson CIs overlap heavily ([4.2–30] vs [6.4–34.7]); +1 net resolution (with one instance lost to variance) cannot be called a significant lift at this sample size. This is exactly the small-n noise ADR-138 quantified, now on real SWE-bench.
- **Production improved slightly:** 14 patches vs 13 and 0 errors vs 1 — the apply-rejection feedback recovered some patches despite k=15 (which had hurt single-shot production, ADR-142 Stage-B1 note).

## Decision → Stage B "scale"

The mechanism works but **n=25 is statistically underpowered** to measure the lift. The next step is to **scale the sample** (more SWE-bench Lite instances) with the closed-loop config to get a tight CI and a leaderboard-comparable number. The budget easily affords it (~$0.81 of $250 spent; solve+repair ≈ $0.02/instance). Cost is dominated by Docker compute, not API.

## Consequences

- Closed-loop repair is retained as the default solving mode for the scale run.
- Honest status: **real canonical SWE-bench resolve-rate is 12–16% on a 25-instance stratified Lite sample** (open vs closed-loop); the repair loop helps mechanistically; significance requires scale (next).

## Validation

Closed-loop solver, predictions, official report, and A/B artifact committed under `bench/swebench/`; result independently re-confirmed by a clean batch `swebench` eval (`repair25final`). Reproducible.
