# @metaharness/example-huggingface

> One command scaffolds a multi-agent Hugging Face harness: model + dataset discovery, serverless inference, and Space exploration — wired to all MetaHarness hosts.

> ⚠️ **Illustrative output.** Transcripts and example runs shown in this README are representative examples, not captured from a specific live run. Actual output depends on your HF token scope, chosen models, provider availability, and rate limits. Run the commands to see real results.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-huggingface)](https://www.npmjs.com/package/@metaharness/example-huggingface)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-huggingface)](https://www.npmjs.com/package/@metaharness/example-huggingface)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![Built with MetaHarness](https://img.shields.io/badge/built%20with-metaharness-7c3aed)](https://www.npmjs.com/package/metaharness)

---

## Intro

`@metaharness/example-huggingface` scaffolds a MetaHarness agent harness pre-wired to the official Hugging Face JavaScript SDK (`@huggingface/inference` + `@huggingface/hub`). One command produces a project with three specialized agents, tiered model routing, a scoped MCP policy, and a `/hf-discover` slash command — ready to run against any of the nine supported hosts (Claude Code, Codex, Copilot, GitHub Actions, Hermes, OpenClaw, OpenCode, pi-dev, RVM).

**This scaffold IS:**
- A ready-made starting point for agents that discover open models, run serverless inference, and explore Spaces.
- An illustrative demonstration of MetaHarness capabilities (tiered routing, MCP default-deny, verification gates) against a real third-party platform.
- Safe to run immediately: all default operations are read-only against public Hub content.

**This scaffold is NOT:**
- A production inference service or model-serving stack. Use Hugging Face Inference Endpoints for production workloads.
- A certified AI-Act, GDPR, or HIPAA-compliant system.
- A replacement for the full Hugging Face Python ecosystem (`transformers`, `datasets`, `diffusers`). It targets JavaScript/Node.js agents.

---

## Features

| Capability | How this example demonstrates it |
|---|---|
| **Model discovery** | `hub-planner` agent fans out `listModels` with task/library/sort filters to rank candidates by download count and recency |
| **Dataset discovery** | `hub-planner` also calls `listDatasets` filtered by task tags to surface relevant training/eval data |
| **Serverless inference** | `inference-executor` calls `InferenceClient` for chat completion, text classification, feature extraction, and text-to-image against the HF Inference provider (free) or a named partner provider |
| **Space exploration** | `hub-planner` lists Spaces (`listSpaces`) linked to the discovered model so the agent can surface live demo URLs |
| **Tiered model routing** | Haiku for Hub API fan-out; Sonnet for model selection reasoning and verification |
| **MCP default-deny** | `.harness/mcp-policy.json` grants only `WebFetch`, `WebSearch`, `Read`, `Write`; `Bash` and all MCP server tools are denied by default |
| **Slash command** | `/hf-discover` fires the full three-agent pipeline from a natural-language task description |
| **Verification gate** | `verifier` agent re-runs a lightweight read-back (e.g. re-classify a sample) before marking output done |
| **All-host scaffolding** | `--host all` emits config for all nine MetaHarness hosts in one run |

---

## Quickstart

```bash
npx @metaharness/example-huggingface@latest my-hf-bot
cd my-hf-bot && npm install && npm run doctor
```

Then set your token and launch:

```bash
export HF_TOKEN="hf_..."
claude -p --plugin-dir my-hf-bot "/hf-discover text classification for sentiment analysis"
```

To scaffold for a different host:

```bash
npx @metaharness/example-huggingface@latest my-hf-bot --host codex
npx @metaharness/example-huggingface@latest my-hf-bot --host all
```

---

## Configuration

### Required environment variable

| Variable | Description | Where to get it |
|---|---|---|
| `HF_TOKEN` | Hugging Face User Access Token (`hf_...`) | [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) — create a **read** fine-grained token; a **write** token is required only with `--allow-write` |

The scaffold generates `.env.example` with `HF_TOKEN=` and adds `.env` to `.gitignore`. Never paste your token into any scaffolded file.

### Optional environment variables

| Variable | Default | Description |
|---|---|---|
| `HF_INFERENCE_PROVIDER` | `hf-inference` | Inference provider to use. `hf-inference` is the free CPU-based tier. Set to `together`, `cerebras`, `groq`, `replicate`, `fal-ai`, etc. to use a paid partner provider. Third-party providers bill per token/image — check their pricing before switching. |
| `HF_DEFAULT_MODEL` | _(task-specific)_ | Override the model the `inference-executor` agent selects. Must be a valid Hub model ID (e.g. `mistralai/Mistral-7B-Instruct-v0.2`). |

### No sandbox mode

Hugging Face does not offer a dedicated sandbox or test-key system. Safety in this scaffold is structural:

- All default operations (`listModels`, `listDatasets`, `listSpaces`, `InferenceClient` calls on the free HF Inference provider) are **read-only** and carry no side-effects or charges.
- Write operations (`createRepo`, `uploadFile`) are **not wired into any agent by default**. Pass `--allow-write` at scaffold time to unlock them, and use a write-scoped token.
- The `verifier` agent re-checks output before returning it as done.
- `npm run doctor` scans scaffolded files for accidental token embedding (the `hf_` prefix pattern).

If you switch `HF_INFERENCE_PROVIDER` to a paid partner, you are responsible for any charges that partner incurs.

---

## Usage

### Slash command

```
/hf-discover <natural-language task description>
```

**Examples:**

```
/hf-discover Find the top sentiment-analysis model and classify: "This product is excellent"
/hf-discover Discover multilingual NER models and tag entities in: "Angela Merkel visited Berlin"
/hf-discover Find a text-to-image model and generate: a photo of a red fox in snow
```

### Representative natural-language prompt

```
Find the most-downloaded transformer model for zero-shot text classification,
run it on the sentence "I need to cancel my subscription",
using candidate labels [billing, support, technical], and verify the result.
```

Expected flow (illustrative):

```
[hub-planner]        listModels: task=zero-shot-classification sort=downloads → top 3 candidates
[hub-planner]        listSpaces: linked Spaces for facebook/bart-large-mnli → 4 Spaces found
[inference-executor] InferenceClient.zeroShotClassification → {label: "billing", score: 0.91}
[verifier]           re-run on held-out sentence → scores consistent, output marked done
```

---

## Safety

- **Secrets via ENV only.** `HF_TOKEN` is read from the environment at runtime. It is never written to scaffolded files and is never logged.
- **Read-only by default.** No Hub state is mutated unless `--allow-write` is explicitly passed at scaffold time.
- **No charges by default.** The scaffold defaults to the free HF Inference provider (`hf-inference`). Switching to a third-party provider (`HF_INFERENCE_PROVIDER=together`, etc.) may incur real charges on that provider's billing system — check their pricing.
- **Gated models.** Some models require you to accept a license at `huggingface.co/<org>/<model>` before your token grants inference access. The `verifier` agent surfaces `403 Forbidden` errors with an actionable link to the gating page.
- **Not certified for regulated use.** This example is illustrative. Data sent to the HF Inference provider or to third-party partners is subject to those services' terms of service and privacy policies. It is not certified for HIPAA, GDPR, or EU AI Act compliance out of the box.
- **MCP surface is narrow.** Only `WebFetch`, `WebSearch`, `Read`, and `Write` are granted. `Bash` and all MCP server tools are denied in the default policy.

---

## How it works

### Agents

**`hub-planner`** (Tier 2 — Haiku): Receives the user's task description. Constructs filter parameters and fans out parallel `listModels` + `listDatasets` + `listSpaces` calls via `@huggingface/hub`. Ranks candidates by download count and recency. Returns a short-list (max 5) with Hub URLs and Space links.

**`inference-executor`** (Tier 3 — Sonnet): Receives the ranked model list. Reasons about which model best fits the user's intent (task type, language, size trade-off). Calls `InferenceClient` with the appropriate method (`chatCompletion`, `textClassification`, `featureExtraction`, `textToImage`, etc.). Returns structured output with the model ID, provider used, and raw result.

**`verifier`** (Tier 3 — Sonnet): Re-reads the inference result against the original task specification. For classification tasks, re-runs the inference on a distinct sample to confirm score consistency. For generation tasks, checks that the output length and format match expectations. Only after passing the verification gate does the harness mark the task as done.

### Routing tiers

| Tier | Model | Latency | Used for |
|---|---|---|---|
| 1 | WASM booster | <1 ms | JSON field extraction from Hub API paginated responses |
| 2 | Haiku | ~500 ms | `hub-planner` — Hub API fan-out, ranking, Space listing |
| 3 | Sonnet | 2–5 s | `inference-executor` — model selection; `verifier` — semantic validation |

### MCP policy (granted tools only)

The `.harness/mcp-policy.json` grants a minimal surface under ADR-022 default-deny:

| Tool | Reason granted |
|---|---|
| `WebFetch` | Fetch HF Hub JSON API responses and model card pages |
| `WebSearch` | Discover model papers, community discussions, Space URLs |
| `Read` | Read local agent prompt files and scaffolded config |
| `Write` | Write inference result to a local output file for read-back verification |

All other tools — including `Bash`, `Edit`, and all MCP server tools — are explicitly denied. An audit log is written to `.harness/audit.jsonl` on every tool call.

---

## Links

- `@huggingface/inference` npm: [npmjs.com/package/@huggingface/inference](https://www.npmjs.com/package/@huggingface/inference)
- `@huggingface/hub` npm: [npmjs.com/package/@huggingface/hub](https://www.npmjs.com/package/@huggingface/hub)
- Hugging Face JS libraries docs: [huggingface.co/docs/huggingface.js/en/index](https://huggingface.co/docs/huggingface.js/en/index)
- Inference Providers docs: [huggingface.co/docs/inference-providers/index](https://huggingface.co/docs/inference-providers/index)
- HF Access Tokens: [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
- ADR-061 (this design): `docs/adrs/ADR-061-example-huggingface.md` in [ruvnet/agent-harness-generator](https://github.com/ruvnet/agent-harness-generator)
- ADR-051 (examples program): `docs/adrs/ADR-051-third-party-sdk-showcase-examples.md`
