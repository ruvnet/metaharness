# ADR-237: evals-math LIVE GSM8K — a FAST, $0 real-compounding domain testbed

- **Status**: Accepted — live wiring shipped + pipeline validated end-to-end at $0. The FULL compounding experiment (real evidence or an honest null) is the immediate next step.
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
