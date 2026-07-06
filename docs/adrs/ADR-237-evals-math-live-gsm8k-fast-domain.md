# ADR-237: evals-math LIVE GSM8K — a FAST, $0 real-compounding domain testbed

- **Status**: Accepted — live run COMPLETE. Mechanism proven end-to-end on a SECOND real domain (GSM8K) at $0; compounding is an HONEST NULL (0/16 promotions), with the gate correctly rejecting a harmful mutation. Confirms the recover-not-create ceiling (ADR-234) is domain-general, not a SWE-bench artifact.
- **Date**: 2026-07-06
- **Deciders**: ruv
- **Tags**: flywheel, evals-math, gsm8k, domain-scale, live, $0-local, metaharness
- **Extends**: ADR-233 (evals adapter pattern), ADR-235 (honest-null replay + gate re-execution), ADR-236 (the SWE-bench domain run this complements)
- **Artifacts**: `packages/evals-math/src/data.ts` (`loadGsm8kFromHub` + `parseGsm8kGold`), `packages/evals-math/bench/{freeze-gsm8k.mjs,gsm8k-frozen.json,math-live-run.mjs}`, `packages/evals-math/__tests__/gsm8k-data.test.ts`.

---

## 1. Context

The `@metaharness/flywheel` engine's central open question is empirical: **does it compound on a REAL domain with a REAL model?** The SWE-bench D1 run (ADR-236) answered it only as an HONEST NULL, and a *positive* run there is gated on **machine-hours** — an agentic solver over a Docker gold-scoring harness is multi-hour and GPU/CPU-saturating, so it stays confirm-gated and small.

The evals-* verticals shipped SYNTHETIC-proven. But **one of them is genuinely runnable LIVE, fast, and free**: math. GSM8K is a **public** HuggingFace dataset (loadable via the datasets-server rows API with **no token**), its gold answers are integers (`#### N`), and grading is **exact-match**. So a real flywheel compounding experiment on math is **text-Q&A only** — no Docker, no test execution — and runs in **minutes** against a **$0** local endpoint. It answers the same core question as SWE-bench, without the gate.

## 2. Decision

Wire evals-math for a live GSM8K run, reusing the proven SWE-bench live-run shape:

- **`loadGsm8kFromHub` + `parseGsm8kGold`** (`data.ts`): the throwing stub becomes a real network loader that parses each row's `#### N` gold and **drops any unparseable row — never fabricates a gold answer**.
- **`bench/freeze-gsm8k.mjs` → `bench/gsm8k-frozen.json`**: loads real GSM8K once and splits it **deterministically** (hash-sort, no RNG → byte-reproducible) into the four disjoint sets, committing the hashed manifest (`splitFingerprint`) so the split is provably fixed **before** any tuning.
- **`bench/math-live-run.mjs`**: a live `SolveFn` against a local OpenAI-compatible endpoint (the same `$0`-local pattern as the SWE-bench runner — `--api-key-env NONE` / a localhost `--base-url`), the `$0` deterministic `makeMathProposer`, and `mathPromotionRule` composing the FROZEN `meetsPromotionRule` **verbatim**. `--plan`/`--resume`/per-generation checkpoint/signed replay bundle.

**`meetsPromotionRule` is UNTOUCHED.** Only exact-match against the committed GSM8K gold scores — no judge, no fabrication. `dataSource` is `LIVE`; the replay bundle is externally verifiable against the pinned composite-gate fingerprint.

## 3. Validation (this ADR's evidence so far)

The pipeline is **validated end-to-end at $0**: a small run (`qwen2.5-coder:7b` @ `localhost:11434`, 3-item holdout, 1 generation) completed the full chain — live solve → answer-normalize → exact-match gold-score → flywheel generation → composite gate → **a signed replay bundle that verifies (`replay: PASS`, `data_source: LIVE`)** — at **$0** spend. This proves the runner + gold-scoring + gate + replay work on real GSM8K with a real model; it is **not** a compounding result (3 items, 1 generation).

**GPU note (why model choice matters):** `qwen2.5-coder:7b` (≈4.7 GB) fits the 16 GB GPU (≈2–4 s/call); `qwen2.5-coder:32b` (≈24 GB) does **not** — it CPU-offloads at ≈53 s/call, which would make a real run impractically slow. A coder model also tends to emit code; the numeric-first normalizer still extracts the final answer, but a general-reasoning model may give a cleaner signal.

## 4. Consequences

- MetaHarness gains a **fast, $0, non-gated** path to a real flywheel-compounding result — the complement to the machine-hour-gated SWE-bench run.
- The full experiment (≈40-item holdout, 6–8 generations, mutating verification/self-consistency/confidence/normalization levers) is a **one-command, minutes-long, $0** launch. It will produce either a real compounding curve or an honest null — gold-scored by exact-match, replay-verifiable — **without weakening the frozen promotion rule**.
- Reusable lesson: when a compounding run is gated by *cost or wall-clock*, look for a **checkable** domain (public gold + exact-match) that exercises the same engine cheaply — the domain changes, the frozen gate and the honesty discipline do not.


## 5. The LIVE run result (2026-07-06) — HONEST NULL on a second real domain, $0

Executed for real at $0: `math-live-run.mjs --model qwen2.5-coder:7b --holdout 20 --anchor 15 --generations 4`.
Gold-scored by EXACT-MATCH against the committed GSM8K gold. Signed replay bundle committed
(`proof-bundle-gsm8k.json`, `data_source: LIVE`, replay **PASS**) + `analyze-gsm8k.json`.

| Metric | Value |
|---|---|
| Base (gen-0 root) accuracy | **0.80** (16/20 on the frozen holdout) |
| Candidates evaluated (4 gens × 4 levers) | 16 |
| Promotions / verified / anchor-surviving | **0 / 0 / 0** |
| `milestone_reached` | false |
| Anchor regressions admitted | 0 |
| Replay (incl. gate re-execution) | **PASS** |
| Spend | **$0.0000** (local endpoint) |

**What this proves (honestly):**
- **The flywheel mechanism generalizes to a SECOND real domain.** The same engine that ran on real
  SWE-bench (ADR-236) runs end-to-end on real GSM8K math-QA — live solve → exact-match gold-score →
  composite gate (`mathPromotionRule` composing the FROZEN `meetsPromotionRule` verbatim) → a signed,
  externally-replayable, gate-re-executing bundle. Every replay check passes. `meetsPromotionRule` UNTOUCHED.
- **The gate + anti-Goodhart discipline work under a live signal.** Of the 16 candidates, the one that
  turned `normalizeFinalAnswer` OFF *regressed* the holdout by −0.15 (answer extraction from the coder
  model's output depends on normalization) — and the gate **rejected it**. Normalization is load-bearing;
  the default policy is already near-optimal for this base, and the flywheel correctly declines to "improve"
  it into something worse.

**What this does NOT prove (the honest limit):** **compounding is NULL** — 0/16 promotions, `milestone=false`.
Most levers (verification / self-consistency / confidence) moved holdout accuracy by exactly 0.00: with an
80% base and clean answer extraction, there is little *preventable* loss for a policy mutation to recover —
the remaining ~20% are genuine model-reasoning failures on hard word problems, which answer-formatting /
voting policy cannot fix. This is the **ADR-234 recover-not-creation ceiling, shown again on a different
domain** — which is the point: the null is **domain-general**, not a SWE-bench artifact. A positive
compounding result needs a base with real *preventable* headroom (a weaker/ messier base, or levers that
change the reasoning itself, not just its packaging) — never a weaker gate.

**Caveats (kept explicit):** the 20-item holdout is a coarse 5%-per-item grid (small lever effects below one
item are invisible); `qwen2.5-coder:7b` is a code model (writes code, though the numeric-first normalizer
extracts the final answer — base 80% confirms extraction works). A larger holdout + a general-reasoning
model would sharpen the measurement, but would not change the ceiling argument.
