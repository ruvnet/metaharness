# Submit to the Cost-Pareto Leaderboard

**[Live board →](https://ruvnet.github.io/metaharness/cost-pareto.html)**

The leaderboard ranks coding-agent harnesses by **resolve-per-dollar** on public SWE benchmarks — the cheapest
system that reaches each level of capability, scored by a tunable **Value Score** (capability blended with price).
Anyone can add a result via pull request. This page is the how.

We accept results for any harness/model — not just Darwin. The bar is **conformance + reproducible evidence**, not
who built it.

---

## 1. The one rule that gets a submission rejected: conformance

**The solver must NEVER see the gold tests during solving.** On SWE-bench that means the `FAIL_TO_PASS` and
`PASS_TO_PASS` tests are used **only** for final scoring — never shown to the model, never used to select/rank
candidate patches, never used as a stopping signal. A run that peeks at gold (directly or via an oracle selector)
is **not conformant** and will be marked as such or rejected.

You *may* use the repository's own existing tests as a regression signal during solving — that's fair game (it's
what a developer has). You may **not** use the benchmark's hidden gold tests.

If your pipeline selects among N candidates, the selector must be gold-free too (an LLM judge, repo tests, etc. —
not the gold tests). State exactly how selection works in your PR.

## 2. Run the benchmark

1. Produce predictions in the standard SWE-bench format — one JSON object per line:
   ```json
   {"instance_id":"astropy__astropy-14995","model_name_or_path":"your-harness","model_patch":"diff --git ..."}
   ```
2. Score with the **official harness** (do not self-grade):
   ```bash
   python -m swebench.harness.run_evaluation \
     --dataset_name princeton-nlp/SWE-bench_Lite \
     --predictions_path preds.jsonl \
     --run_id my-harness --cache_level env --max_workers 4
   ```
   (`--cache_level env` keeps disk bounded; the full 300/500-image set otherwise overruns small disks.)
3. Read `resolved` / `total` from the generated report. **`resolved` = instances passing all `FAIL_TO_PASS` +
   `PASS_TO_PASS`.** Empty patches count as unresolved.

Darwin's own GCP runner that does solve → gold-eval → self-report is in `scripts/gcp-swebench-runner.sh` if you
want a reference implementation.

## 3. Compute the numbers

- **resolve %** = `resolved / total × 100` (use the full benchmark size as the denominator — partial runs are
  marked as pilots, see `kind` below).
- **Wilson 95% CI** — `[lo, hi]` for `resolved` of `total`. ([formula](https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval))
- **cost / instance ($)** — your *measured* model spend for one instance (sum of all API calls for that instance,
  averaged). If you can only estimate, mark `costEst: true`. Be honest; the whole board is about cost.

## 4. Add your row

Edit **`apps/web-ui/public/assets/swe-pareto.json`** → `benchmarks.<lite|verified|pro>.entries[]` and append:

```json
{
  "name": "YourHarness · config",
  "scaffold": "one-line description of the loop (e.g. interactive ReAct, Best-of-3 + judge)",
  "model": "Model-Name",
  "resolve": 41.3,
  "ci": [35.8, 47.0],
  "cost": 0.042,
  "kind": "meas",
  "costEst": false,
  "note": "124/300 full-300, gold, conformant; cost = measured OpenRouter spend",
  "src": "https://link-to-your-evidence"
}
```

| field | meaning |
|---|---|
| `name` | how it appears on the board (`Harness · config`) |
| `scaffold` | the orchestration in one line |
| `model` | base model(s) |
| `resolve` | resolve % (one decimal) |
| `ci` | Wilson 95% `[lo, hi]` |
| `cost` | measured $/instance (`null` if undisclosed → sorts last) |
| `kind` | `meas` (full-set measured) · `pilot` (n<full or projected) · `official` (a published third-party number) |
| `costEst` | `true` if cost is estimated, not metered |
| `note` | `resolved/total`, conformance, cost basis — keep it factual |
| `src` | link to predictions + eval report (required for `meas`) |

The board auto-builds tabs and sorts by Value Score — no other code changes needed.

## 5. Evidence (required for `kind: "meas"`)

Link, in the PR, to:
- your **predictions `.jsonl`** (the patches you scored), and
- the **official eval report** JSON (the `run_evaluation` output with `resolved_ids`), and
- a **one-line repro command** (dataset + harness + how to regenerate).

Self-reported numbers without a reproducible eval report stay `kind: "pilot"` at best.

## 6. Open the PR

Checklist:
- [ ] Conformant (no gold tests seen during solving) — described in the PR body
- [ ] Scored with the official `swebench` harness (not self-graded)
- [ ] `resolve`, `ci`, `cost` filled with **measured** values (`costEst: true` if estimated)
- [ ] Evidence linked (predictions + eval report) for `meas` rows
- [ ] One row added to the right benchmark tab in `swe-pareto.json`

Title the PR `leaderboard: <Harness> on <benchmark>` and we'll review for conformance + reproducibility.

---

*Honest numbers only. A measured 38% beats a hand-wavy 60% — the entire point of this board is that the cost and
the conformance are real.*
