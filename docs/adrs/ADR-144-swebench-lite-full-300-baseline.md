# ADR-144: Darwin Mode — full SWE-bench Lite baseline (all 300, open-loop, fixed deepseek)

**Status**: Accepted (measured) — the definitive, un-cherry-picked, tight-CI Darwin SWE-bench Lite number
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-142 (stratified-25 pilot), ADR-143 (closed-loop A/B), ADR-135/139 (deepseek default), ADR-145 (router proposal — this run is its baseline + labels)

> ADR-142/143 measured cherry-picked stratified-25 samples (12–16%). This is the **whole benchmark**: all 300 SWE-bench Lite (test) instances, open-loop fixed-deepseek, scored by the official `swebench` Docker harness. No selection bias, n=300, a genuinely tight CI — the honest headline figure.

## Method

Identical solver to ADR-142 (`bench/swebench/solve.mjs`, k=12), run over the **full 300** (`full-300.json`). Open-loop, single-shot, `deepseek/deepseek-chat`. Official `swebench` 4.1.0 Docker harness for resolved scoring. (200 instances produced no patch → auto-unresolved; the 100 patched were Docker-evaluated, 0 errors.)

## Result (real, 2026-06-18)

```
RESOLVED:  23 / 300  = 7.7%      Wilson 95% CI [5.2%, 11.2%]
patch produced:  100/300 (33%)   of patched, 23% resolved
errors: 0        solve cost: $2.75 (deepseek)   eval: ~1.5h Docker (89 image builds)
```

**Per-repo resolved:** django 15/114, pytest 2/17, requests 2/6, sympy 2/77, astropy 1/6, xarray 1/5; **zero** on matplotlib (0/23), scikit-learn (0/23), sphinx (0/16), pylint (0/6), seaborn (0/4), flask (0/3).

## Honest interpretation

- **7.7% [5.2, 11.2] is the real, un-cherry-picked Darwin-on-SWE-bench-Lite number** — open-loop, single-shot, $0.4/Mtok model, ~$0.009/instance. As predicted, it sits **below** the stratified-25 pilot's 12% (that sample was selected for easy functional fixes; the full set includes django/sympy multi-file bugs).
- **Context vs the leaderboard:** top SWE-bench Verified setups report 65–88% — using **iterative agentic loops + frontier models at $1–20/instance**. This is a single-shot cheap-model *baseline*; the gap is the scaffolding (repair loop, ADR-143) and model (router, ADR-145), not the plumbing. The plumbing is sound and the number is real.
- **The 67% empty-patch rate is the dominant loss** (200/300 produced no patch — selection miss or non-matching SEARCH on 800+-file repos), exactly as the pilot flagged. Of the 100 patched, 23% resolved.
- **Repo signal is informative:** django (15/114) and the small high-overlap repos (requests, pytest) carry the resolves; the zero-resolve repos (matplotlib, sklearn, sphinx) are where selection/patch-production fails hardest — a concrete target.

## Significance

This is the figure ADR-098 demanded before any external claim: a real, reproducible, tight-CI number on the canonical benchmark. It also **is the data-generation phase for ADR-145**: every instance now has a deepseek resolve label (embedding → resolved?), the training signal the router needs. A second-model (gpt-5-mini) full-300 pass gives the contrastive labels to make routing learnable.

## Consequences

- **Headline:** Darwin Mode (open-loop, deepseek, single-shot) resolves **7.7% [5.2–11.2%] of SWE-bench Lite** for ~$2.75.
- Next levers, in measured order: (1) patch-production on large repos (the 67% empty rate is the biggest single lever); (2) the repair loop at scale (ADR-143 showed +mechanism at n=25); (3) the router (ADR-145), now that baseline labels exist.

## Validation

Solver, full-300 manifest, predictions, official report, and analysis committed under `bench/swebench/`; resolve-rate + Wilson CI from `analyze.mjs` over the official `swebench` report (`lite300`). Reproducible end-to-end.
