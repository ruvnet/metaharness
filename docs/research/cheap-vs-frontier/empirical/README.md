# Empirical: cheap models vs older-frontier on everyday-agentic tasks

This directory holds the **empirical half** of the *cheap-vs-frontier* thesis:
do an optimized agentic harness + cheap models (**DeepSeek-V4-Pro**, **GLM-5.2**)
match older-frontier models (**Claude Opus 4.5**, **GPT-5.2**) on **everyday-agentic**
work — general-assistant, multi-step, tool-using QA — at a large cost discount?

It complements the SWE-bench (code domain) Pareto data in `../data/`. This is the
**non-code, everyday-work** domain the thesis is actually about.

## Benchmark: FRAMES (open GAIA-class proxy)

The thesis names **GAIA** as the primary everyday-agentic benchmark. GAIA's
validation set is **HuggingFace-GATED**: downloading it requires a human to accept
the dataset license on the account tied to the `HF_TOKEN`. From this environment
that acceptance is not present (file downloads return *"Access to dataset … is
restricted"*; only public tree-listing works). The official-GAIA path is kept
ready — the harness is dataset-agnostic, so once a terms-accepted `HF_TOKEN` is
provided, a `gaia-loader.mjs` emitting the same manifest shape runs the identical
solver+scorer against GAIA validation.

For an **open, ungated, reproducible** measurement now we use **Google FRAMES**
(`google/frames-benchmark`, Krishna et al. 2024): **824 real-world multi-hop
general-assistant questions**, each with one gold `Answer` and gold Wikipedia
evidence pages. FRAMES is the recognised open GAIA-class proxy — multi-step
retrieval + reasoning over real knowledge — and is **$0-infra** to run (Wikipedia
is keyless via the MediaWiki API). Honest caveat: FRAMES absolute accuracy is
**not** comparable to GAIA's leaderboard numbers; what transfers is the
**cross-model comparison at an identical harness**, which is exactly the thesis.

## Harness (same scaffold for every model — only the model id changes)

`packages/darwin-mode/bench/gaia/`:

| File | Role |
|------|------|
| `frames-loader.mjs` | FRAMES → seeded manifest `{task_id, question, answer, reasoning_types}` (seed fixes the SAME subset for every model). |
| `wiki-tools.mjs` | Keyless MediaWiki tools: `search(query)`, `open(title, query)`. |
| `solve-gaia.mjs` | Bounded ReAct agentic loop (`search`/`open`/`submit`). Reuses the SWE-bench OpenRouter client (per-call `usage.cost`), `--max-cost` budget gate, worker-pool concurrency, and `parseAction`/`stateHash` anti-thrash. **Leak-free**: the gold answer is never put in any prompt. |
| `score-gaia.mjs` | GAIA-style normalized **exact-match** (numeric/list/string pathways ported from the official `scorer.py`), Wilson 95% CI, `$/task`, `$/correct`. |

Scoring is **conformant** (exact-match after normalization, no LLM-judge, no
answer leakage). `acc_em` is the headline; `acc_relaxed` (gold tokens contained
in the prediction) is reported as a lenient secondary.

## Model matrix (verified live on OpenRouter, 2026-06-28)

| Tier | Model id | Prompt $/M | Completion $/M | Notes |
|------|----------|-----------:|---------------:|-------|
| Cheap | `deepseek/deepseek-v4-pro` | 0.43 | 0.87 | thesis cheap model |
| Cheap | `z-ai/glm-5.2` | 0.95 | 3.00 | thesis cheap model |
| Older-frontier | `anthropic/claude-opus-4.5` | 5.00 | 25.00 | Nov-2025 frontier |
| Older-frontier | `openai/gpt-5.2` | 1.75 | 14.00 | few-months-old frontier (gpt-5.5 is current) |

Blended (3:1 prompt:completion) list-price ratio, Opus-4.5 vs DeepSeek-V4-Pro
≈ **18.5×**; the *measured* `$/task` ratio (which depends on how many tokens each
model actually spends per agentic episode) is the real headline and is reported
per run in `summary.json`.

## Budget gate (research sub-budget)

Tracked on the OpenRouter key `usage` (the loop-spend meter):

- Baseline at campaign start: **$2441.11** (matches the brief's "absolute ~$2439").
- Hard cap: **$2639** (+$200 research delta). Dispatch aborts above it.
- First-batch plan: n=50 × 4 models, per-model `--max-cost` gates
  (deepseek 3, glm 4, gpt-5.2 10, opus 15) → worst case ≈ $32, well under headroom.

## Execution (GCP fleet — local box kept light)

`scripts/gcp-frames-runner.sh` runs on a small `e2-small` GCE VM (no Docker, pure
network I/O): clones this branch, runs loader→solve→score for one model, and
self-reports the Pareto point to Firestore `frames_runs`. One VM per model
(concurrent swarm), `AUTOSTOP` halts each when done, controller reaps TERMINATED.

## Results layout

Per-model `results-<model-slug>.json` (schema = `score-gaia.mjs` output) plus
`summary.json` / `SUMMARY.md` aggregating resolve, `$/task`, cost-ratio, and the
cheap-vs-frontier verdict. Populated as the sweep returns; this is a 12h `/loop`
campaign — the first batch lands here, the loop extends n. A local n=3 deepseek
smoke run validated the pipeline end-to-end (2/3 EM, $0.011/task) before dispatch.
