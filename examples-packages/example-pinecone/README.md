# MetaHarness x Pinecone — RAG memory agent

Scaffold a production-pattern RAG memory harness pre-wired to Pinecone's serverless vector database — across every MetaHarness host — with one command.

> **Illustrative output.** The scaffolded harness, all code samples in this README, and any agent responses shown are illustrative. They demonstrate integration patterns, not verified production behaviour. Pinecone API responses depend on your live data and index state.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-pinecone?label=%40metaharness%2Fexample-pinecone)](https://www.npmjs.com/package/@metaharness/example-pinecone)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-pinecone)](https://www.npmjs.com/package/@metaharness/example-pinecone)
[![license](https://img.shields.io/npm/l/@metaharness/example-pinecone)](https://github.com/ruvnet/agent-harness-generator/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@metaharness/example-pinecone)](https://nodejs.org)
[![built with metaharness](https://img.shields.io/badge/built%20with-metaharness-6366f1)](https://www.npmjs.com/package/metaharness)

---

## Introduction

This package scaffolds a MetaHarness agent harness that uses **Pinecone** as a persistent vector memory namespace. The harness can upsert text documents into a serverless Pinecone index (via Pinecone's integrated inference — no separate embedding model required), retrieve semantically similar chunks by natural-language query, rerank results, and verify that the memory namespace contains what the agent wrote.

**What this is:** a runnable, one-command starting point for building RAG-enabled agents that store and retrieve knowledge from Pinecone, with tiered model routing, MCP default-deny policy, and a verification gate.

**What this is not:** a production RAG system, a HIPAA-compliant data store, a replacement for your embedding pipeline, or a Pinecone substitute. It is an illustrative scaffold you own and extend.

---

## Features

| MetaHarness capability | How this example implements it |
|---|---|
| **Tiered model routing** (ADR-026) | Haiku-class model for intent parsing, record chunking, and read-back comparison; frontier model for multi-document planning and error recovery |
| **MCP default-deny** (ADR-022) | `.harness/mcp-policy.json` grants exactly 9 Pinecone MCP tools; all other tools denied; writes require `PINECONE_ALLOW_WRITE=true` and explicit approval |
| **Slash command** | `/rag-memory` drives the full loop: parse intent, optionally upsert, search, rerank, verify |
| **Specialized agents** | `pinecone-planner` (decompose + batch), `pinecone-executor` (SDK calls), `pinecone-verifier` (read-back check + stats assertion) |
| **Verification gate** (ADR-050) | After every upsert the verifier runs `searchRecords` with the original text and asserts inserted IDs appear in top-K results; `describeIndexStats` confirms namespace vector count |
| **Multi-host scaffold** | `--host all` emits configs for claude-code, codex, copilot, github-actions, hermes, openclaw, opencode, pi-dev, rvm |

Pinecone-specific capabilities showcased:

- **Serverless index with integrated inference** — `createIndexForModel` using `multilingual-e5-large`; no embedding service to operate
- **Namespace isolation** — each harness instance writes to its own namespace (`harness-dev` by default); queries never cross namespace boundaries
- **Semantic search with reranking** — `searchRecords` with `bge-reranker-v2-m3` for two-stage retrieval
- **Multi-index cascading search** — `cascading-search` across multiple indexes with deduplication

---

## Quickstart

```bash
npx @metaharness/example-pinecone@latest my-bot
cd my-bot && npm install && npm run doctor
```

`npm run doctor` checks that your Node version is >= 20, that `PINECONE_API_KEY` is set, that the `.harness/mcp-policy.json` is well-formed, and that the Pinecone index specified by `PINECONE_INDEX_NAME` exists (or reports that it will be created on first run).

To scaffold for a specific host:

```bash
npx @metaharness/example-pinecone@latest my-bot --host codex
```

To scaffold for all hosts at once:

```bash
npx @metaharness/example-pinecone@latest my-bot --host all
```

---

## Configuration

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PINECONE_API_KEY` | Yes | — | Your Pinecone API key. Get it from [app.pinecone.io](https://app.pinecone.io) under API Keys. Never commit this value. |
| `PINECONE_INDEX_NAME` | No | `harness-memory` | Name of the serverless index. Created on first run if it does not exist. |
| `PINECONE_NAMESPACE` | No | `harness-dev` | Namespace within the index. Isolates dev data from other namespaces. |
| `PINECONE_CLOUD` | No | `aws` | Cloud provider for the serverless index (`aws`, `gcp`, `azure`). |
| `PINECONE_REGION` | No | `us-east-1` | Region for the serverless index. |
| `PINECONE_ALLOW_WRITE` | No | unset | Set to `true` to enable upsert and index-creation operations. Unset = read-only mode. |

### Where to get your API key

1. Sign in to [app.pinecone.io](https://app.pinecone.io).
2. Click **API Keys** in the left sidebar.
3. Click **Create API Key**, give it a name, and copy the value.
4. Add it to your environment: `export PINECONE_API_KEY="pcsk_..."` (or add to a `.env` file that is listed in `.gitignore`).

The free tier includes one project, one index, and 100 000 vectors — sufficient for development and prototyping without incurring cost.

### No sandbox mode

Pinecone does not offer a sandbox API endpoint or test keys. Every API call reaches the live Pinecone service. The harness defaults to **read-only** (no `PINECONE_ALLOW_WRITE`) and targets the `harness-dev` namespace so that development activity is isolated from any production data you may have in the same project. Use a dedicated development project in the Pinecone console for maximum isolation.

### Setting variables securely

```bash
# Shell profile (never commit)
export PINECONE_API_KEY="pcsk_..."

# .env file (add .env to .gitignore)
PINECONE_API_KEY=pcsk_...
PINECONE_ALLOW_WRITE=true

# In CI (GitHub Actions example)
# Store as a repository secret named PINECONE_API_KEY
# Reference: ${{ secrets.PINECONE_API_KEY }}
```

---

## Usage

### `/rag-memory` slash command

The primary command. In read-only mode (default) it searches and verifies. With `PINECONE_ALLOW_WRITE=true` it upserts before searching.

```
/rag-memory store "The Pinecone SDK uses PINECONE_API_KEY for auth"
/rag-memory store "Namespace isolation partitions vectors within a single index"
/rag-memory query "how does Pinecone handle multi-tenancy?"
```

**Read-only query (default):**

```
/rag-memory query "what embedding model does integrated inference use?"
```

The planner parses the question, the executor calls `searchRecords` on the configured index, the verifier confirms the results are non-empty and that metadata fields are present, and the formatted top-K chunks are returned.

### Representative natural-language prompts

```
"Store these three paragraphs about our API design in the Pinecone memory namespace, then confirm they are retrievable."

"Search the harness memory for anything related to authentication and summarise the top 3 results."

"How many vectors are currently in the harness-dev namespace?"

"Run a cascading search across the harness-memory and product-docs indexes for information about rate limits."
```

---

## Safety

- **Secrets via environment only.** `PINECONE_API_KEY` is never written to any scaffolded file. The `npm run doctor` step warns if it is absent.
- **Read-only by default.** Upsert and index-creation calls are guarded by `PINECONE_ALLOW_WRITE=true`. Without that flag the harness cannot modify your Pinecone data.
- **Namespace isolation.** The default namespace `harness-dev` keeps scaffolded-harness data separate from any other namespaces in your index. Change `PINECONE_NAMESPACE` to further isolate.
- **MCP default-deny.** The `.harness/mcp-policy.json` grants exactly the Pinecone tools needed and nothing else. Shell access, file writes, and arbitrary network calls are all denied.
- **Verification gate.** The harness does not report a write as successful until the verifier has confirmed the data is retrievable. This catches partial failures and silent errors.
- **No PII guidance.** Do not upsert personally identifiable information, health records, or payment data into the example index without independently reviewing Pinecone's compliance posture (SOC 2 Type II certified; HIPAA add-on available on Standard/Enterprise plans) and your own data-handling obligations.
- **Not for production without review.** This scaffold is a learning and prototyping tool. It does not implement access-token scoping, row-level security, audit logging beyond the MCP policy log, or disaster recovery. Review and harden before any production use.

---

## How it works

### Agents

```
pinecone-planner   (Tier 2 — Haiku)
  ↓ parsed intent + batch plan
pinecone-executor  (Tier 2 Haiku / Tier 3 Sonnet for multi-step)
  ↓ SDK results
pinecone-verifier  (Tier 2 — Haiku)
  ↓ verified or error
/rag-memory response to user
```

**`pinecone-planner`** receives the raw user instruction, extracts: the operation (store/query/stats), the text or query, target namespace, and any metadata. For bulk ingest it produces a batch plan (chunks of up to 100 records).

**`pinecone-executor`** makes the Pinecone SDK calls. For writes (`PINECONE_ALLOW_WRITE=true`): checks whether the index exists via `listIndexes`; calls `createIndexForModel` if needed (idempotent, `waitUntilReady: true`); calls `upsertRecords` in the planned batches. For reads: calls `searchRecords` with optional reranking. Calls `describeIndexStats` for namespace summaries.

**`pinecone-verifier`** re-issues a `searchRecords` call with the original input text after every upsert and asserts that the inserted record IDs appear in the top-K results. It also calls `describeIndexStats` and confirms the namespace vector count has increased. If either assertion fails, the harness surfaces an explicit verification error rather than silently reporting success.

### Routing tiers

| Tier | What runs there |
|---|---|
| Tier 1 (WASM / no LLM) | JSON record assembly, namespace slug normalization, ID generation |
| Tier 2 (cheap model) | Intent parsing, chunk boundary detection, read-back comparison, stats interpretation |
| Tier 3 (frontier model) | Multi-document corpus planning, reranking strategy selection, error recovery |

### MCP policy — granted tools

The harness mounts the official `pinecone-io/pinecone-mcp` server (GA, 2026) and grants exactly these tools:

| Tool | Purpose | Write-gated |
|---|---|---|
| `pinecone__search-docs` | Search official Pinecone documentation | No |
| `pinecone__list-indexes` | List all indexes in the project | No |
| `pinecone__describe-index` | Describe index configuration | No |
| `pinecone__describe-index-stats` | Get namespace vector counts + stats | No |
| `pinecone__search-records` | Semantic search with optional metadata filter | No |
| `pinecone__rerank-documents` | Rerank a result set | No |
| `pinecone__cascading-search` | Search across multiple indexes | No |
| `pinecone__create-index-for-model` | Create integrated-inference index | Yes (`PINECONE_ALLOW_WRITE`) |
| `pinecone__upsert-records` | Insert/update text records | Yes (`PINECONE_ALLOW_WRITE`) |

All other MCP tools are denied. Shell, file-write, and arbitrary-network tools are not granted.

---

## Links

- [Pinecone TypeScript SDK (`@pinecone-database/pinecone`)](https://www.npmjs.com/package/@pinecone-database/pinecone)
- [Pinecone TypeScript SDK reference](https://sdk.pinecone.io/typescript/)
- [Pinecone TypeScript client on GitHub](https://github.com/pinecone-io/pinecone-ts-client)
- [Pinecone MCP server (`pinecone-io/pinecone-mcp`)](https://github.com/pinecone-io/pinecone-mcp)
- [Pinecone integrated inference guide](https://github.com/pinecone-io/pinecone-ts-client/blob/main/guides/inference/integrated-inference.md)
- [Pinecone authentication](https://docs.pinecone.io/reference/api/authentication)
- [ADR-062 (this example's design record)](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-062-example-pinecone.md)
- [ADR-051 (examples program)](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md)
