# ADR-150: Tailscale-served local frontier model + concurrent benchmark tracks

**Status**: Proposed (architecture + harness support implemented; live run gated on the Mac being online)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-148 (cheap→frontier escalation), ADR-259 (local ruvllm mutator), ADR-144/146/149 (SWE-bench), ADR-135 (model frontier)

> A 48 GB-unified-memory Mac (Studio/mini) on the tailnet is a private, $0-inference "frontier-tier" OpenAI-compatible endpoint. A `Qwen2.5-Coder-32B` GGUF (Q4/Q5, ~19–23 GB) fits alongside Docker (~12 GB) under 48 GB with metal acceleration. Over Tailscale it looks exactly like the OpenAI API to the Darwin harness — but free and air-gapped. This rewrites ADR-148's economics: the 35B model becomes the *baseline* solver, not a budgeted escalation, so the full repair loop can run on all 300 instances "over the weekend" for the cost of electricity.

## Decision

1. **Inference server (Mac):** `ruvllm serve` (or llama.cpp/Ollama) on the Mac, bound to its tailscale IP (`100.x:PORT`), exposing OpenAI-compatible `POST /v1/chat/completions`.
2. **Harness (orchestrator, here):** the SWE-bench solvers accept a configurable `--base-url` (OpenAI-compatible). Default stays OpenRouter; pointing it at the Mac's tailscale endpoint routes inference to the free local model. No other harness change — the Mac is just another endpoint.
3. **Concurrent benchmark tracks:** because inference is decoupled by endpoint, multiple benchmark processes run **concurrently** — e.g. the hosted `deepseek` track (OpenRouter) and a local `qwen-coder-32b` track (Mac) over the same corpus, each writing its own predictions/report. Combined with the per-run `--concurrency` pool (ADR: solve-repair), this gives two axes of parallelism: within a track (instances) and across tracks (models/endpoints).

## Harness support (implemented this session)

- `solve.mjs` / `solve-repair.mjs`: `--base-url <url>` (OpenAI-compatible; default `https://openrouter.ai/api/v1`) + `--api-key-env <VAR>` so a keyless local endpoint works. Verified the flag plumbs through to the chat-completions call.
- This makes a concurrent local-Mac track a one-command launch once the server is up:
  `solve-repair.mjs --base-url http://ruv-mac-mini:8000/v1 --model qwen2.5-coder-32b --localize --attempts 3 --concurrency 4 --out predictions-mac.jsonl`.

## Honest status / gating

- **The Mac is currently OFFLINE on the tailnet** (`ruv-mac-mini` last seen minutes ago, `reuvens-mac-mini` ~hours ago; tailscale ping no reply, SSH timeout). So the *live* run is blocked until it's online and `ruvllm serve` (or equivalent) is running a 32B GGUF.
- The ruvllm download path was just fixed upstream (RuVector PR #590, the 307-redirect bug); a separate GGUF-glob/registry bug still blocks `ruvllm download` of GGUF weights — so the Mac server may need llama.cpp/Ollama for the GGUF until that lands, or a manually-placed model.
- **No local-model SWE-bench number is claimed** until a real served run exists (ADR-098 discipline). The economics argument (35B-as-baseline) is sound but the resolve-rate is unmeasured.

## Consequences

- When the Mac is online: launch a concurrent `qwen-coder-32b` track alongside the hosted track; compare resolve-rate at $0 inference (the "substitute model scale with environmental scaffolding + free local frontier" thesis).
- ADR-148's escalation can then escalate to the *local* 35B (free) instead of a paid frontier — collapsing the cost ceiling entirely.

## First measured result (2026-06-19) — local qwen2.5-coder:7b, $0 inference

Ran the open-loop solver against **ruvultra ollama** (`qwen2.5-coder:7b`, localhost, $0) on the
stratified-25 sample, official `swebench` Docker eval:

| metric | value |
|---|---|
| resolved | **1/25 = 4.0%** (Wilson 95%: [0.7, 19.5]) |
| patches applied | 13/25 |
| resolved instance | `pytest-dev__pytest-5227` |
| inference cost | **$0.00** (local) |

Honest read vs the hosted deepseek pilot on the *same* 25 (~12–16%): the free 7B lands **~⅓–¼**
the hosted resolve-rate — below, as predicted by the reasoning ceiling. The *story* is the
**harness-lift at the apply layer**: qwen-7b went from **0/25 → 13/25 applied** once the harness
(a) served a 32k context (ollama default 4096 truncated the code prompts), (b) carried the
search/replace format contract in a **system message + worked example**, and (c) **shrank per-file
context** (`--slice`) so the prompt fit the window and the instruction survived truncation. Without
those, a weak local model emits prose summaries, not patches. The remaining apply→resolve gap is
SEARCH-text precision + single-shot — the **closed-loop repair** track (solve-repair, test feedback)
is the next measurement, expected to lift the local resolve-rate materially.

Provenance fix: solve.mjs now labels predictions with the actual `--model` (was hardcoded
`darwin-deepseek-searchreplace`).

## Validation

`--base-url`/`--api-key-env`/`--slice` + system-message format contract committed in the solvers;
first local $0 number measured (1/25, above). Larger local models (gpt-oss:20b on the Mac, qwen-32b)
and the closed-loop repair track are the next levers. Live Mac endpoint deferred to its ollama
binding 0.0.0.0 (CLAUDE.local.md).
