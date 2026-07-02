# ADR-206: BenchPress-style low-rank score prediction — model onboarding & tier placement for MetaHarness

- **Status**: Proposed
- **Date**: 2026-07-02
- **Deciders**: ruv
- **Tags**: metaharness, routing, benchmarking, cost, onboarding
- **Source paper**: Zeng & Papailiopoulos, *"You Don't Need to Run Every Eval"*, arXiv:2606.24020 (Microsoft Research, 2026-06-22) — [code](https://github.com/microsoft/benchpress) · [dataset](https://huggingface.co/datasets/microsoft/benchpress-score-matrix)

---

## Context

### The problem: tier placement is our most expensive recurring decision

MetaHarness routes each task to the best **(harness × model)** pair. That requires knowing, for every candidate model, roughly where it sits on the cost-vs-resolve Pareto surface — per harness. Today we answer that question by **running full gold-scored benchmark slices per model**, which this session cost, per model:

| what we ran (2026-07-02) | cost | outcome |
|---|---|---|
| 4-model Claude ladder, pilot-25 × claude-p | ~$121 | frontier = Sonnet-5 + Fable-5; Haiku & Opus **dominated** |
| GLM-5.2 vs deepseek A/B, pilot-25 × darwin | ~$13 | GLM-5.2 **strictly dominates** deepseek (8/25 ⊃ 3/25) |
| Fable hard-25 × claude-p | ~$61 | 23/25 — the only hard-tail solver |
| darwin→claude-p handoff arm, hard-25 | ~$75 | 24/25 (ADR-205 proof) |

So a *single* new model's placement costs **$60–$125** (frontier pricing, two harnesses, gold-scored) plus hours of wall-clock — and new models land weekly (we already run an hourly OpenRouter watcher for Fable-class releases; GLM-5.2 and deepseek-v4-pro both appeared *during* this session). Tier placement is a recurring, growing cost.

### The paper's finding

BenchPress compiles a **84 models × 133 benchmarks** public score matrix (2,604 cells, 23.3% fill) and shows it is **effectively rank-2**: two latent factors explain >90% of score variance; rank-sweeping matrix completion bottoms out at rank 2. On top of this they build a **logit-space rank-2 ALS matrix-completion predictor** with a conformal confidence layer. Headline numbers:

- Recovers held-out scores to **4.6 points median absolute error** at full coverage.
- **5 probe benchmarks** recover a model's *entire* scorecard to **3.93 MedAE** (4.55 with a low-cost probe set).
- Preserves **92.1% of pairwise model rankings** (5-point margin).
- A **newly released model**: 5 seed scores → **5.0 MedAE** on everything else — even when the training matrix predates the release.
- A **confidence layer** (ensemble spread + conformal calibration) yields 90% prediction intervals and says when *not* to trust a prediction.

Implication for us: **placement does not require running every eval.** A handful of probe scores + matrix completion predicts the rest — with a trust flag for when it can't.

### The novel extension: the harness axis

The paper's matrix is *model × benchmark*. Ours must be **model × (harness × slice)** — because MetaHarness's central measured fact is that **harness interacts with model**:

| model | darwin loop | claude-p loop |
|---|:--:|:--:|
| deepseek | ~35% (rep) / 12% (pilot) | **0%** |
| GLM-5.2 | 32% (pilot) | untested (predicted ~0 — Claude-co-tuned loop) |
| Fable 5 | 64% (rep) | **92% (hard)** / 84% (pilot) |
| Sonnet 5 | ~1/25 (hard) | 72% (pilot) |

That crossing interaction is exactly rank-2-expressible: **factor 1 ≈ general code capability, factor 2 ≈ harness affinity** (tool-native/Claude-loop fit). This is a testable hypothesis (P0 below), and if it holds, the two BenchPress factors acquire a *mechanistic interpretation* in our domain — the same two numbers that place a model also predict *which loop* it needs. That is the mathematical spine of the MetaHarness routing thesis ("model quality × wrong loop = capped").

### Why this matters strategically

The product opportunity (per the Fable report) is **the router, the harness, and the escalation policy — not the model**. A living, gold-scored model×harness score matrix is proprietary flywheel data: every benchmark arm we run becomes a row/column that makes the *next* placement cheaper. BenchPress turns our benchmarking history into a predictive asset.

---

## Decision

Adopt a **BenchPress-style low-rank score predictor as the MetaHarness model-onboarding and tier-placement layer**:

1. Maintain a **score matrix** of models × (harness × slice) columns, seeded from the public BenchPress matrix (code/agentic columns) plus our own gold-scored rows, with per-cell provenance.
2. Reimplement the predictor (**logit-space rank-2 ALS**, ~200 LOC) in the existing `.mjs` bench toolchain — no Python dependency.
3. Derive a **code-probe set** (≤10 instances across the two harnesses, ~$5–15/model) by greedy forward-selection on the matrix.
4. Ship an **onboarding pipeline**: new OR model → run probes → complete its row → predicted Pareto position + tier proposal → **conformal confidence gate** (low confidence ⇒ fall back to today's full benchmark run) → human-approved config PR.

### Explicit non-goals (scope boundary)

- **NOT a per-request router or escalate-trigger.** BenchPress predicts *benchmark aggregates*, never per-instance pass/fail. The per-request "did this tier fail?" signal is meta-llm ADR-225 (calibrated escalate-trigger) and the ADR-205 handoff receipts. These layers compose: BenchPress places the *model*; the calibrated trigger routes the *request*.
- **NOT availability gating.** ADR-221's probe answers "is Fable up?"; this ADR answers "where does model X belong?". Orthogonal.
- **NOT a replacement for gold-scoring.** Headline claims (README numbers, reports, papers) stay gold-scored. Predictions are for *placement decisions* with an explicit trust gate.

---

## Architecture

```
                       ┌────────────────────────────────────┐
  OpenRouter watcher   │  Score Matrix (living dataset)     │
  (hourly, exists) ──► │  rows: models (OR slugs)           │
                       │  cols: (harness × slice) + public  │
  new model detected   │  cells: score + provenance         │
        │              │  {source, harness, date, gold?}    │
        ▼              └───────────────┬────────────────────┘
  ┌───────────────┐                    │ fit
  │ Probe Runner  │                    ▼
  │ probe-5-code  │        ┌───────────────────────┐
  │ (claude-p +   │ scores │ Predictor (rank-2 ALS │
  │  darwin, ~$15)│ ─────► │ in logit space, .mjs) │
  └───────────────┘        │ + conformal intervals │
                           └──────────┬────────────┘
                                      │ predicted row + 90% CIs
                                      ▼
                        ┌────────────────────────────┐
                        │ Placement Report           │
                        │ • predicted resolve/$ per  │
                        │   (harness × slice)        │
                        │ • Pareto verdict           │
                        │   (frontier / dominated)   │
                        │ • tier proposal (low/mid/  │
                        │   high) + confidence       │
                        └──────────┬─────────────────┘
                     high conf     │      low conf
              ┌────────────────────┴──────────────┐
              ▼                                   ▼
   human-approved tier-config PR        full benchmark run
   (meta-llm seedPools / Firestore      (today's process —
    tier_config — never auto-deploy)     the fallback, not
                                         the default)
```

### Component detail

**1. Score matrix** (`packages/darwin-mode/bench/scorematrix/`)
- `matrix.json` (or parquet if it grows): `{model, column, score, ci?, provenance: {source_url, harness, slice, n_instances, gold_scored, date}}`.
- Columns, initial set: our gold cells — `(claude-p, pilot-25)`, `(claude-p, hard-25)`, `(darwin, pilot-25)`, `(darwin, rep-50)`, `(darwin, full-300)` — plus **public code/agentic columns** imported from `microsoft/benchpress-score-matrix`: SWE-bench Verified, Aider Polyglot, Terminal-Bench, LiveCodeBench, Codeforces, plus 2–3 reasoning anchors (GPQA-D, MMLU-Pro) because the paper shows cross-domain factors carry signal.
- Rows, initial: our 6 measured models (Haiku-4.5, Sonnet-5, Opus-4.8, Fable-5, GLM-5.2, deepseek) ∪ the public matrix's 84.
- **Provenance is load-bearing**: vendor-reported scores are optimistic and harness-confounded (the paper's own caveat, and our measured lesson — our custom harness under-scores frontier models by design artifacts). Gold cells are trusted; vendor cells are noisy features.

**2. Predictor** (`scorematrix/predict.mjs`)
- Logit transform (clip endpoints) → per-column standardization → **rank-2 ALS** completion → invert. Faithful to the paper's chosen method (it beat 11 alternatives across 7 transforms).
- Confidence: ensemble over initializations/hold-out folds → spread → conformal calibration on held-out cells → 90% intervals per prediction. A prediction is **trusted** iff interval width ≤ τ_width AND matrix support is adequate (≥8 observed models on the target column, ≥5 observed columns on the target model — the paper's density thresholds).
- Unit tests against the public matrix: reproduce ~4.6 MedAE held-out (sanity bar; we accept ≤6.0 on code-only columns since fewer columns = less signal).

**3. Probe sets** (`scorematrix/probes/`)
- `probe-code-A`: 5 instances from pilot-25 × claude-p (the 5 that maximize scorecard recovery, greedy forward-selection identical to the paper's §5.1 procedure but on our merged matrix).
- `probe-code-B`: 5 instances × darwin loop (captures the harness-affinity factor — a model must be probed in BOTH loops to place its factor-2).
- Probe cost: ≤$15 frontier / ≤$2 cheap models. Re-derive probes whenever the matrix grows by ≥25% (paper caveat iv: probe sets are snapshot-specific).

**4. Onboarding pipeline** (`scorematrix/onboard-model.mjs --model <or-slug>`)
- Runs probes (reuses `claude-p-solve.mjs` + `solve-agentic.mjs` as executors — they already exist), gold-scores the ≤10 instances (cheap at this N), inserts cells, completes the row, emits the placement report (markdown + JSON).
- Wire into the existing hourly OR watcher: new model in a tracked family ⇒ auto-run probes ⇒ post placement report. **Tier config changes remain human-approved PRs** (meta-llm `seedPools` / Firestore `tier_config`) — the pipeline proposes, never deploys.

---

## Phases

| phase | scope | cost | exit criterion |
|---|---|---|---|
| **P0 — validate** | Port rank-2 logit ALS to `.mjs` (+tests); import public matrix; reproduce held-out MedAE on code columns; **test the harness-affinity hypothesis** (do our gold cells fit the rank-2 completion of the merged matrix? does factor-2 separate darwin-favored from claude-p-favored models?) | $0 (compute only) | MedAE ≤6.0 on code columns; interaction hypothesis report (confirm/refute) |
| **P1 — probes + backtest** | Greedy probe selection; **leave-one-model-out backtest**: hide each measured model's row, predict from its probe cells only, compare predicted tier vs measured tier | $0 (reuses existing gold data) | ≥5/6 models placed in their measured tier; the deepseek×claude-p outlier (0/25 interaction) either predicted or **flagged low-confidence — never confidently wrong** |
| **P2 — pipeline** | `onboard-model.mjs`; hook the hourly OR watcher; first live placement of a genuinely new model (e.g., next Qwen/Kimi/GLM release) | ~$15/model | placement report + proposed config diff produced end-to-end; conformal gate exercised |
| **P3 — optional surface** | Expose `predict_score(model, column)` via the ruflo-metaharness MCP plugin; publish the gold sub-matrix as a living dataset | — | deferred until P2 proves value |

---

## Consequences

### Positive
- **~10× cheaper model placement** ($60–125 → ≤$15/model) with an explicit trust gate; full runs become the *fallback*, not the default.
- Every benchmark arm we've already run becomes reusable training signal — the flywheel: more placements → denser matrix → better predictions → cheaper placements.
- If the harness-affinity factor hypothesis holds (P0), MetaHarness routing gets a principled 2-D capability space instead of hand-assigned tiers — and "which loop does this model need?" becomes predictable *before* running it.
- Placement decisions become auditable (provenance per cell, confidence per prediction) instead of ad-hoc.

### Negative
- **Aggregates only** — contributes nothing to per-request escalation (ADR-225 remains the hard, unproven piece of the routing story).
- **Small-N noise floor**: a 25-instance slice has binomial std ≈ 8 points at p=0.8 — *comparable to the 4.6-pt prediction error*. Predictions are tier-grade (low/mid/high buckets ≥20 pts wide), **not** fine-ranking-grade. We must not over-read them.
- Cold-start density: our gold columns need ≥8 observed model rows before the completion can predict them; today we have 4–6. Bootstrapping requires probing a few more OR models (~$30–50 one-time) — acceptable, but real.
- Maintenance: probe sets and factors drift as the model population shifts (paper caveat ii/iv); re-derivation is a recurring (cheap) chore.

### Neutral
- Rank-2 was measured on a heterogeneous public snapshot; the paper is explicit that a future capability profile can break the geometry. Our conformal gate is the designed failure mode: a rank-2-breaking model gets flagged, not silently mis-placed.
- Vendor-score contamination is inherited from the public seed matrix; mitigated (not eliminated) by preferring gold cells and recording provenance.

---

## Acceptance (ADR-level)

This ADR is **validated** when P1's backtest passes: hiding each of our six gold-measured models and predicting from ≤10 probe cells recovers the measured Pareto verdicts — Sonnet on-frontier, Haiku dominated, Opus dominated, Fable top, GLM>deepseek — for ≥5/6 models, with the sixth flagged low-confidence rather than confidently wrong. It is **operational** when P2 places its first never-benchmarked model for ≤$15 with a placement report an operator accepts or rejects in one read.

## Links

- Paper: [arXiv:2606.24020](https://arxiv.org/abs/2606.24020) · [code](https://github.com/microsoft/benchpress) · [score matrix dataset](https://huggingface.co/datasets/microsoft/benchpress-score-matrix)
- [[ADR-205]] Harness handoff beats model embedding — the per-instance routing layer this composes with
- meta-llm ADR-224 (prompt-caching strategy) / **ADR-225 (calibrated escalate-trigger — the per-request layer; explicitly out of scope here)**
- meta-llm ADR-221 (Fable-5 availability gate — orthogonal: liveness, not placement)
- [[ADR-194]] per-instance evolution (hard-tail diagnosis harness — instance-level, complementary)
- Session evidence: `packages/darwin-mode/bench/swebench/{HANDOFF.md, gold-*-report.json, orladder-*-report.json}` · `docs/FABLE-REPORT.md`
