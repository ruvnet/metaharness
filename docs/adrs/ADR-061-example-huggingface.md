# ADR-061: example-huggingface — Hugging Face SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Hugging Face is the reference open-ML platform hosting 2 M+ models, 1.5 M+ datasets, and 1.5 M Spaces as of mid-2026. Its JS/TS SDK — the `huggingface.js` monorepo — ships two packages that together cover the full lifecycle an agent would realistically drive:

- **`@huggingface/inference`** (v4.13.19): a unified `InferenceClient` that routes serverless inference to the HF Inference provider (CPU-focused, free tier) or to 20+ third-party inference partners (Together AI, Cerebras, Replicate, fal.ai, Groq, etc.) and to dedicated Inference Endpoints. It exposes chat completion, text generation, feature extraction, summarization, text-to-image, zero-shot classification, ASR, and more — all behind the same typed interface.
- **`@huggingface/hub`** (v2.13.1): async-generator functions (`listModels`, `listDatasets`, `listSpaces`, `listFiles`, `fileDownload`, `whoAmI`) for read-only Hub exploration, plus write operations (`createRepo`, `uploadFile`, `deleteFiles`) that require a write-scoped token.

Prospective metaharness users building ML pipelines, dataset-exploration tools, or model-evaluation harnesses want a one-command starting point that shows how an agent can discover the best model for a task, run serverless inference against it, and validate the result — without hand-wiring auth, routing tiers, or an MCP policy from scratch.

Hugging Face has **no dedicated sandbox or test-key system** analogous to Stripe's test mode. Safety is achieved structurally: the Hub's read APIs (`listModels`, `listDatasets`, `listSpaces`, `fileDownload`) require no write permissions and carry no side-effects; inference calls on the free HF Inference provider incur no charge beyond rate-limit consumption. Mutations (repo creation, file uploads) are gated behind a separate write-scoped token and an explicit `--allow-write` flag in this scaffold.

This ADR records the design decisions for `@metaharness/example-huggingface` (ADR-051 catalog entry 061).

---

## Decision

### Chosen SDK

Primary: **`@huggingface/inference`** + **`@huggingface/hub`** from the `huggingface/huggingface.js` monorepo. Both are ESM-first, TypeScript-typed, and actively maintained (inference at v4.13.x, hub at v2.13.x as of June 2026). No alternative JS client approaches this breadth with official support.

Import style:

```js
import { InferenceClient } from "@huggingface/inference";
import { listModels, listDatasets, listSpaces, fileDownload, whoAmI } from "@huggingface/hub";
```

### Headline capability

The scaffold demonstrates three sequenced capabilities an agent would realistically drive end-to-end:

1. **Model and dataset discovery** — `listModels` / `listDatasets` with filter, sort, and search parameters to find the best-fit model for a given task tag (e.g. `task: "text-classification"`, `library: "transformers"`, `sort: "downloads"`).
2. **Serverless inference** — `InferenceClient.chatCompletion`, `textClassification`, `featureExtraction`, and `textToImage` against the discovered model via the HF Inference provider (free, CPU) or a chosen partner provider.
3. **Space discovery and read-back** — `listSpaces` to find live demo Spaces for the chosen model; read-back of the inference result for the verification gate.

### Agent / skill design

Three specialized agents are scaffolded:

| Agent | File | Tier | Role |
|---|---|---|---|
| `hub-planner` | `agents/hub-planner.md` | Tier 2 (Haiku) | Decomposes the user's ML task into a search query, selects filter parameters, fans out `listModels` + `listDatasets` calls, and ranks candidates by downloads and recency. |
| `inference-executor` | `agents/inference-executor.md` | Tier 3 (Sonnet) | Receives the ranked model list, selects the best candidate, constructs the inference call, executes it via `InferenceClient`, and returns structured output. |
| `verifier` | `agents/verifier.md` | Tier 3 (Sonnet) | Re-reads the inference result against the task specification and, for text tasks, performs a lightweight semantic sanity-check (e.g. zero-shot classification re-run) before marking output as done. |

Slash command: **`/hf-discover`** — the entry point that accepts a natural-language task description, fires `hub-planner`, chains to `inference-executor`, then gates on `verifier` before returning.

### Routing tiers (ADR-026)

| Tier | Handler | Latency | Use in this example |
|---|---|---|---|
| 1 | WASM booster | <1 ms | JSON field extraction from Hub API responses (no LLM) |
| 2 | Haiku | ~500 ms | `hub-planner` — fan-out search, filter construction, candidate ranking |
| 3 | Sonnet | 2–5 s | `inference-executor` — model selection reasoning; `verifier` — semantic validation |

Frontier-tier calls (Opus) are not used in this example; the verification gate does not require adversarial reasoning beyond Sonnet.

### MCP policy

The scoped `.harness/mcp-policy.json` follows ADR-022 default-deny. Only the following tools are granted:

```json
{
  "version": "1",
  "default": "deny",
  "grants": [
    { "tool": "WebFetch",   "reason": "fetch HF Hub JSON API responses" },
    { "tool": "WebSearch",  "reason": "discover model papers and Space URLs" },
    { "tool": "Read",       "reason": "read local agent prompt files" },
    { "tool": "Write",      "reason": "write inference result to output file (read-back)" }
  ],
  "denied": [
    "Bash", "Edit", "ListMcpResourcesTool", "mcp__*"
  ],
  "audit": { "enabled": true, "path": ".harness/audit.jsonl" }
}
```

`Bash` is denied by default to prevent shell-escape during unattended runs. If the user opts in to write operations via `--allow-write`, the policy emits a second file `.harness/mcp-policy.write.json` that additionally grants the `uploadFile` / `createRepo` hub functions, logged to the same audit trail.

### Auth model

Credentials flow exclusively via environment variable:

- **`HF_TOKEN`** — a Hugging Face User Access Token (`hf_...`), created at `https://huggingface.co/settings/tokens`. A **read-only** fine-grained token is sufficient for all default scaffold operations. A **write** token is required only when `--allow-write` is set.

The token is passed at runtime:
- To `InferenceClient` as its first constructor argument: `new InferenceClient(process.env.HF_TOKEN)`.
- To hub functions via the `credentials` parameter: `{ accessToken: process.env.HF_TOKEN }`.

The scaffold generates a `.env.example` listing `HF_TOKEN=` and a `.gitignore` entry for `.env`. It never writes the actual token to any scaffolded file.

Hub read APIs (`listModels`, `listDatasets`, `listSpaces`) also accept unauthenticated requests for public content at a lower rate limit. The scaffold degrades gracefully if `HF_TOKEN` is absent — it warns and proceeds with read-only unauthenticated access.

### Safety gates

Hugging Face has no test-mode key system. Safety is enforced structurally:

1. **Read-only by default.** All scaffold operations use `listModels`, `listDatasets`, `listSpaces`, and `InferenceClient` inference calls. None of these mutate Hub state. Rate limits on the free HF Inference tier are enforced server-side.
2. **Write operations gated behind `--allow-write`.** `createRepo` and `uploadFile` (from `@huggingface/hub`) are not scaffolded into any agent by default. They are only wired in when the user passes `--allow-write` at scaffold time, and the generated README prominently marks those code paths as mutating.
3. **Inference cost awareness.** The free HF Inference provider is rate-limited and costs nothing beyond the token. Third-party providers (Together, Replicate, Groq, etc.) bill per token/image. The scaffold defaults to the HF Inference provider. Switching providers requires explicitly setting `HF_INFERENCE_PROVIDER` and understanding that third-party billing applies.
4. **Verification gate (ADR-050).** The `verifier` agent re-runs a lightweight read-back check (re-classify or re-embed a subset of the inference output) before the harness marks the task done.
5. **No credentials in files.** The scaffold checks for accidental token embedding at `npm run doctor` time via a grep of scaffolded files for the `hf_` prefix pattern.

---

## Consequences

### Positive

- Provides a one-command starting point for any agent that needs to discover open models and run serverless inference — one of the most common ML engineering tasks.
- Demonstrates metaharness tiered routing concretely: Haiku for Hub API fan-out (cheap and fast), Sonnet for model selection and verification (where reasoning matters).
- The MCP policy is narrow and auditable — only `WebFetch`, `WebSearch`, `Read`, and `Write` are granted; no shell access.
- Read-only default means the example is safe to run by anyone with a free HF account and a read token.
- Covers Spaces discovery, making the example relevant for users who want to embed or interact with Gradio/Streamlit demos programmatically.

### Limitations

- **No dedicated sandbox.** Unlike Stripe (test keys) or Twilio (magic numbers), HF has no isolated test environment. The safety posture relies on API read-only semantics rather than a separate test endpoint. Users must be aware that inference calls on third-party providers (if `HF_INFERENCE_PROVIDER` is set) may incur real charges.
- **Free HF Inference tier is CPU-only and rate-limited.** As of mid-2026, HF Inference focuses on CPU inference (embeddings, text classification, smaller LLMs). Large LLM inference defaults to paid partner providers. The scaffold warns if the chosen model is not available on the free tier.
- **Gated models require approval.** Some popular models (Llama 3, Gemma) require the user to accept a license on `huggingface.co` before the token grants inference access. The `verifier` agent surfaces `403 Gated model` errors with an actionable link.
- **Not a production inference stack.** This example is illustrative. For production ML serving, use Hugging Face Inference Endpoints (dedicated, autoscaling) or a managed provider — not the free serverless tier.
- **Not certified for regulated use.** The example makes no claims about GDPR, HIPAA, or AI-Act compliance. Data sent to third-party inference providers is subject to those providers' terms of service.
