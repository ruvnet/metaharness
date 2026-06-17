# ADR-062: example-pinecone — Pinecone SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Retrieval-Augmented Generation (RAG) is one of the most common patterns in production agent harnesses: rather than cramming knowledge into a prompt, the agent fetches only the relevant chunks from a vector store and passes those to the model. Pinecone is the dominant managed vector database for this pattern, offering a serverless index tier, integrated inference (embedding + reranking without a separate embedding service), namespace isolation for per-agent or per-tenant memory partitioning, and a first-party MCP server (`pinecone-io/pinecone-mcp`) that already exposes upsert, search, rerank, and multi-index cascading to any MCP-capable host.

For a generated harness the practical question is: can the harness treat Pinecone as a persistent memory namespace — storing documents, querying by natural-language similarity, and verifying the result by reading back — on every supported host, with safe defaults, without bespoke wiring? This showcase answers that question with a runnable one-command scaffold.

The primary SDK is `@pinecone-database/pinecone` (official TypeScript client, package `@pinecone-database/pinecone`, current stable version 7.x, Node >= 20 required). Import style: `import { Pinecone } from '@pinecone-database/pinecone'`. Authentication is a single API key set in the `PINECONE_API_KEY` environment variable; the SDK reads it automatically when `new Pinecone()` is called with no arguments. There is no official sandbox or test-key tier (unlike Stripe); safety is achieved by defaulting to read-only operations and by using Pinecone's free tier (1 project, 1 index, 100 000 vectors) as the development target.

## Decision

### Chosen SDK

**`@pinecone-database/pinecone`** v7.x — the official Pinecone TypeScript/Node SDK, maintained by Pinecone, the only package endorsed in the Pinecone documentation for JS/TS usage. It is not `pinecone-client` (deprecated) and not `@langchain/pinecone` (a LangChain wrapper). The integrated-inference surface (`createIndexForModel`, `upsertRecords`, `searchRecords`) is preferred over the raw vector API because it eliminates a separate embedding dependency and aligns with the Pinecone MCP server's own tool surface.

### Headline capability

**RAG memory: upsert text records into a Pinecone index via integrated inference, query by semantic similarity with optional reranking, and read back the top-K results to verify the harness's memory namespace is populated and queryable.** This covers the full read/write/verify loop without requiring an external embedding model.

### Agent and skill design

Three specialized agents are defined:

| Agent | Role | Routing tier |
|---|---|---|
| `pinecone-planner` | Parses the user's intent (what to store, what to search, what index to target, which namespace). Decomposes multi-document ingest into batches. | Tier 2 — Haiku-class; classification + extraction, no complex reasoning |
| `pinecone-executor` | Executes SDK operations: `createIndexForModel` (idempotent check first), `upsertRecords`, `searchRecords`, `describeIndexStats`. Writes are gated by `PINECONE_ALLOW_WRITE`. | Tier 2 — Haiku-class for upsert/stats; Tier 3 for multi-step decisions |
| `pinecone-verifier` | Reads back inserted records via `searchRecords` with the original text, confirms the retrieved `id` matches what was upserted, and calls `describeIndexStats` to verify namespace vector count. | Tier 2 — Haiku-class; deterministic read-back check |

Slash command: **`/rag-memory`** — the single compound command that drives the full loop: parse intent → (optionally upsert) → search → verify → present results. When `PINECONE_ALLOW_WRITE` is unset, the upsert step is skipped and the command operates read-only.

### Routing tiers (ADR-026)

| Tier | Model class | Used for |
|---|---|---|
| 1 (WASM booster) | No LLM | Simple structural transforms: JSON record assembly, namespace slug normalisation |
| 2 (cheap / Haiku) | ~500 ms, $0.0002 | Intent parsing, record chunking, read-back comparison, stats interpretation |
| 3 (frontier / Sonnet) | 2–5 s, $0.003+ | Multi-document corpus planning, reranking-strategy selection, error-recovery decisions |

### MCP policy — granted tools

The `.harness/mcp-policy.json` is default-deny and grants only the following tools from the official `pinecone-io/pinecone-mcp` server (GA as of 2026):

```json
{
  "defaultDeny": true,
  "allowNetwork": true,
  "allowShell": false,
  "allowFileWrite": false,
  "requireApprovalForDangerous": true,
  "toolTimeoutMs": 30000,
  "maxToolCallsPerTurn": 12,
  "auditLog": true,
  "grantedTools": [
    "pinecone__search-docs",
    "pinecone__list-indexes",
    "pinecone__describe-index",
    "pinecone__describe-index-stats",
    "pinecone__search-records",
    "pinecone__rerank-documents",
    "pinecone__cascading-search",
    "pinecone__create-index-for-model",
    "pinecone__upsert-records"
  ]
}
```

`pinecone__upsert-records` and `pinecone__create-index-for-model` are marked `requireApproval: true` in the policy and are blocked entirely unless `PINECONE_ALLOW_WRITE=true` is set in the environment. The verifier exclusively uses `pinecone__search-records` and `pinecone__describe-index-stats`, which are read-only.

**Not granted**: any shell tool, any file-write tool, any network tool outside the Pinecone API surface.

### Auth model

Single environment variable: `PINECONE_API_KEY`. Set in the host's environment (shell profile, `.env` file that is `.gitignore`d, CI secret, or secrets manager). The SDK reads it automatically. No secondary credential, no environment name (legacy pre-2024 SDK required `PINECONE_ENVIRONMENT`; current v7.x does not). API keys are obtained from the Pinecone console at app.pinecone.io under API Keys. Keys grant ReadWrite access to all indexes in the project; scope is controlled at the project level in the Pinecone console, not in the key itself.

### Safety gates

1. **No `PINECONE_API_KEY`, no run** — `bin/scaffold.mjs` and the `npm run doctor` check both emit a clear error and exit before any network call if the key is absent.
2. **Read-only by default** — `upsertRecords` and `createIndexForModel` calls in the scaffolded harness are wrapped in a guard: `if (!process.env.PINECONE_ALLOW_WRITE) throw new Error("Set PINECONE_ALLOW_WRITE=true to enable writes")`. The `/rag-memory` slash command mirrors this: without the flag it runs search-only.
3. **No sandbox tier exists** — Pinecone does not offer test keys or a sandbox API endpoint. Safety is achieved by: (a) the free-tier development index (pinned to 100 000 vectors, no cost), (b) the read-only default, and (c) namespace isolation (`PINECONE_NAMESPACE` defaults to `harness-dev`) so development writes never touch production namespaces.
4. **Verification gate (ADR-050)** — after every `upsertRecords` call the verifier agent issues a `searchRecords` with the original input text and asserts the inserted record IDs appear in the top-K results. If the assertion fails, the harness surfaces a "verification failed" error rather than silently reporting success.
5. **No PII guidance** — the README notes that vectors are derived from text and that users should not upsert personal data to shared indexes without appropriate access controls. The example does not handle PII and is not HIPAA-compliant.

### Index model

The example defaults to a Pinecone integrated-inference index using the `multilingual-e5-large` embedding model (1024 dimensions, cosine metric), which eliminates the need for a separate embedding service. The `PINECONE_INDEX_NAME` and `PINECONE_NAMESPACE` env vars configure the target. `createIndexForModel` is called with `waitUntilReady: true` and is idempotent (the executor checks `listIndexes` before creating).

## Consequences

**Positive**

- One-command scaffold wires a fully functional RAG memory loop across all nine metaharness hosts with a single API key.
- Integrated inference means zero external embedding dependency — the scaffold has one less moving part to break.
- Namespace isolation (`harness-dev` default) makes it safe to run against a shared project without stomping production data.
- The MCP server surface (`pinecone-io/pinecone-mcp`, GA 2026) means hosts that support MCP (Claude Code, Codex, Hermes, OpenCode) get native tool access without any custom server code.
- The verification gate (read-back + stats check) provides an exact, cheap confirmation that the vector store reflects what the agent wrote — turning "upsert returned 200" into "the data is actually there and retrievable".
- The cascading-search tool enables multi-index RAG — a natural extension for users who segment their knowledge across indexes by topic or date.

**Honest limitations**

- No offline/dry-run mode: Pinecone has no local emulator or sandbox endpoint. Every test that touches the Pinecone API requires a live key and makes live network calls. Users on slow or metered networks should be aware.
- Index creation is slow (10–60 s for `waitUntilReady: true`) on first run. Subsequent runs are fast because `createIndexForModel` is idempotent.
- The integrated-inference MCP server supports only integrated-inference indexes. Users who want to manage indexes with external embeddings must use the TypeScript SDK directly (not the MCP server).
- Request-per-second limits: 100 RPS per namespace applies across all data-plane operations as of 2026. Batch ingest of large corpora should use batching (100–500 records per `upsertRecords` call) and respect these limits.
- The example is illustrative. It is not production-hardened, not HIPAA/SOC 2 ready out of the box, and does not implement row-level access control. Pinecone's namespace isolation is a logical partition, not a cryptographic one.

**Not a production deployment.** This example is for learning and prototyping. Do not store sensitive personal data, regulated health information, or payment data in the example index without independent review of Pinecone's compliance posture for your use case.
