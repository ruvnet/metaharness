# DARWIN-SHIELD-BENCH results

Corpus: `darwin-shield-bench@1.0.0` — 10 ground-truth vulns, 9 decoys. 50 evolution cycles.

**Overall: ✅ PASS**

## Baselines vs champion

| Harness | fitness | TPR | FPR | patch-pass | repro | unsafe | cost |
|---|---|---|---|---|---|---|---|
| B0 static-only | 0.5665 | 0.3 | 1 | 1 | 1 | 0 | 4t/1r |
| B1 LLM single-pass | 0.1365 | 0 | 1 | 0 | 0 | 0 | 1t/1r |
| B2 fixed agent | 0.598 | 0.4 | 0.888889 | 1 | 1 | 0 | 2t/1r |
| B3 Darwin champion | 0.93275 | 1 | 0 | 1 | 1 | 0 | 4t/4r |

## Acceptance gates

- ✅ **TPR improvement ≥ 25% vs fixed harness** — +150% (B2 0.4 → B3 1)
- ✅ **FPR reduction ≥ 40%** — −100% (B2 0.888889 → B3 0)
- ✅ **Patch-test pass rate ≥ 80%** — 100%
- ✅ **Reproduction success ≥ 90%** — 100%
- ✅ **Unsafe outputs = 0** — champion=0, baselines=0,0,0
- ✅ **Cost increase ≤ 2× fixed harness** — 1.758929×
- ✅ **All runs reproducible from receipts** — B0=593274e6 B1=2589863b B2=92a56965 B3=5991a555
- ✅ **Champion beats every baseline on fitness** — B3 0.93275 vs [0.5665, 0.1365, 0.598]
- ✅ **Beyond SOTA: champion STATISTICALLY beats the previous champion** — lower95 0.20225 > 0, meanDelta 0.287181, p=0, unsafe-regression=false
- ✅ **Compounding: false-positive repeat-rate drop ≥ 35%** — −100% (cold 4 → warm 0)
- ✅ **Compounding: patch-reuse improvement ≥ 20%** — +100%
- ✅ **Compounding: seeded genomes beat random ≥ 15%** — +47.1209% (seeded 0.724938 vs random 0.49275)

## Statistical promotion (champion vs previous champion)

- mean per-repo Δ: **0.287181** (prev 0.5155 → new 0.80275)
- lower-95% bound: **0.20225** (> 0 required), one-sided p = 0
- verdict: ✅ statistically superior — promoted: lower95 0.20225 > 0, meanDelta 0.287181, zero unsafe

## Compounding (ruVector memory makes the next run smarter)

- false-positive repeat-rate drop: **100%** (≥ 35% required) ✅
- patch-reuse improvement: **100%** (≥ 20% required) ✅
- seeded-vs-random advantage: **47.1209%** (≥ 15% required) ✅

## Champion genome

```json
{
  "id": "g25_v7_8j",
  "parentId": "g24_v11_8b",
  "planner": "sink-first",
  "contextPolicy": "hybrid",
  "reviewerCount": 4,
  "retryBudget": 2,
  "fuzzBudgetSeconds": 15,
  "tools": [
    "semgrep",
    "osv-scanner",
    "codeql",
    "trivy"
  ],
  "modelMix": [
    "claude"
  ],
  "validationPipeline": [
    "static",
    "fuzz",
    "repro-test",
    "review"
  ],
  "safetyProfile": "strict-defensive"
}
```

Lineage: baseline → g0_v1_1 → g1_v13_p → g2_v8_w → g4_v13_1p → g6_v5_25 → g7_v13_2p → g8_v5_2t → g9_v9_39 → g24_v11_8b → g25_v7_8j
