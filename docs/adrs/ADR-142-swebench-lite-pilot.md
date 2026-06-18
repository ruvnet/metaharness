# ADR-142: Darwin Mode — first real canonical SWE-bench number (Lite pilot, ADR-098 boundary lifted)

**Status**: Accepted (measured) — the first real external-benchmark run; lifts the ADR-098 honest boundary
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-098 (external-benchmark strategy / honest boundary), ADR-126 (repair loop), ADR-127 (search/replace), ADR-135/139 (deepseek default), ADR-141 (evolve capstone)

> Since ADR-098 the project refused to claim an external number until a real run existed. This is that run: the validated Darwin harness, on a stratified sample of **canonical SWE-bench Lite** (Python), scored by the **official `swebench` Docker harness**. The honest boundary is now lifted — replaced by a real, CI'd figure.

## Method

- **Sample:** 25 stratified SWE-bench Lite (test) instances — functional fixes (1–2 files, patch ≤1500 chars, 1–3 `FAIL_TO_PASS`), round-robin across all 12 repos, smallest-patch-first (`bench/swebench/pilot-sample-25.json`).
- **Solver (`bench/swebench/solve.mjs`):** per instance, shallow-fetch the repo at `base_commit` → relevance-ranked contextBuilder + symbol-index selectFiles (now language-agnostic, `def`) → `deepseek-chat` emits a **search/replace** edit → apply → `git diff` → `predictions.jsonl`. **Open-loop, single-shot** (no test feedback during solving — that needs the Docker env; deferred to Stage B).
- **Evaluation:** official **`swebench` 4.1.0** Docker harness applies each patch and runs the real `FAIL_TO_PASS`/`PASS_TO_PASS` suites → resolved scoring.

## Result (real, 2026-06-18)

```
resolved:        3 / 25  = 12.0%      Wilson 95% CI [4.2%, 30.0%]
patch produced:  13/25   (12 empty — no candidate patch)
patched but wrong: 10/13
errors:          1        solve cost: $0.23 (deepseek)   eval: Docker compute
resolved: mwaskom/seaborn-3190, pytest-dev/pytest-5227, scikit-learn-13779  (3 distinct repos)
```

## Honest interpretation

- **12% is the floor of a deliberately minimal baseline**, not a ceiling. Leaderboard leaders hit 65–88% on SWE-bench *Verified* using **iterative agentic loops** (execute tests, feed failures back, multiple attempts) with frontier models. This pilot is **open-loop, single-shot, cheap-model** — the simplest configuration, run for cents. The number is real and the comparison is honest: we are on the launchpad, with a measured starting altitude.
- **The dominant loss is patch *production*, not just correctness: 48% (12/25) produced no patch at all** — selection missed the buggy file or the model's SEARCH didn't match on large repos (sympy 0/3, pylint 0/2 never patched). Of the 13 that did patch, 3 resolved (23%).
- **Cross-repo resolution is genuine:** the 3 resolved span seaborn, pytest, and scikit-learn — different codebases, confirming the harness is not a single-project fixture.

## Stage-B leverage (clear, measured)

1. **Add the repair loop with real test feedback** (ADR-126) — run the instance's tests in the Docker env, feed `FAIL_TO_PASS` output back, retry. This is exactly what stronger agentic systems do and what the validated runner already supports; the pilot omitted it. Expected to lift both production and correctness.
2. **Fix patch-production on large repos** — the 48% empty rate is the biggest single lever: better selection on 800+-file repos and handling files beyond the context cap.
3. Only then is model/genome evolution (ADR-133–141) worth re-running against the real fitness.

## Consequences

- **ADR-098's honest boundary is lifted:** a real canonical SWE-bench resolve-rate exists (12%, CI [4.2%, 30%]), reproducible (`bench/swebench/`), scored by the official harness — no fabrication.
- Stage B targets the repair loop + large-repo patch production before scaling the sample, within the $250 budget (≈$0.23 spent on API so far).

## Validation

Solver + sample + predictions + official report + analysis committed under `bench/swebench/`; resolve-rate + Wilson CI computed by `analyze.mjs` from the official `swebench` report. Reproducible end-to-end (HuggingFace dataset + official Docker harness).
