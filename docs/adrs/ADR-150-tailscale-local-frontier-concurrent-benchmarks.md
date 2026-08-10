# ADR-150: Tailscale-served local frontier model + concurrent benchmark tracks

**Status**: Proposed (architecture + harness support implemented; live run gated on the Mac being online)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-148 (cheap→frontier escalation), ADR-259 (local ruvllm mutator), ADR-144/146/149 (SWE-bench), ADR-135 (model frontier)

## Context

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

## Closed-loop repair on the local model — measured, and a discipline catch (2026-06-19)

Ran the **closed-loop repair** track (qwen2.5-coder:7b, $0, localize + ≤3 test-feedback attempts,
working `--k 4 --slice 7000` config) on the same stratified-25:

| local qwen-7b | resolved (batch eval) | patches |
|---|---|---|
| open-loop | 1/25 = 4.0% [0.7, 19.5] | 13/25 |
| closed-loop repair | **1/25 = 4.0%** [0.7, 19.5] | 18/25 |

**Honest negative result: the repair loop did NOT lift the local 7B's final resolve-rate** (1/25
either way), even though it raised patch-production (13→18) and resolved the same instance
(`pytest-dev__pytest-5227`). The 7B reasoning ceiling dominates: more attempts produce more
*applying* patches, but not more *correct* ones.

**Discipline catch:** the repair solver's **in-loop** `evalOne` reported **5/25** resolved, but a
clean **batch eval on the final predictions returned 1/25**. The in-loop signal over-counted (4 of
5 "resolves" did not reproduce — transiently-passing patches that fail a clean re-eval). **Only the
batch eval on final predictions is authoritative.** This is why every committed number in this repo
comes from a batch eval — including ADR-149's 46/300, which is therefore unaffected. Follow-up:
harden `evalOne`'s resolve detection (suspected stale-report or flaky-pass read) so the in-loop
signal is trustworthy; until then it's a progress indicator only, never a reported number.

Net for ADR-150: the **harness-lift is real at the apply layer** (0→13/25 applied, format wall
broken) but **does not convert to resolves on a 7B** — the model is the binding constraint. The
open path is a **stronger local model** (gpt-oss:20b on the Mac, qwen-32b) where repair has correct
patches to converge toward, mirroring the hosted result (deepseek 7.7%→15.3%, ADR-149).

## Validation

`--base-url`/`--api-key-env`/`--slice` + system-message format contract committed in both solvers;
local $0 numbers measured by batch eval (open-loop 1/25, closed-loop 1/25). Next: larger local models
where the repair loop has correct patches to find. Live Mac endpoint deferred to its ollama binding
0.0.0.0 (CLAUDE.local.md).

## Update 2026-06-20: local ladder completed (qwen-14b + repair, full-300)

Official batch eval of the free local track: `qwen2.5-coder:14b` + closed-loop repair =
**20/300 = 6.7% [Wilson 4.4, 10.1]** on full SWE-bench Lite (RESULTS §18). +2pp over the 4.7%
open-loop floor (§13). **Capped by the model's capability floor** — 108/300 instances produced
empty/invalid diffs the 14b couldn't emit, so repair had nothing to iterate on; in-loop over-counted
67→20 (3.4×). The *same harness* on hosted deepseek-v4-pro reaches 29.3% (§15). Conclusion: the
harness is the resolve-rate lever **only above a model capability floor**; below it the base can't emit
the fix at all. Local $0 tracks remain valuable for cheap iteration, but the ceiling is the local model.
