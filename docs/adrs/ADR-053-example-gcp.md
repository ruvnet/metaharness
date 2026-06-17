# ADR-053: example-gcp — Google Cloud Platform SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Google Cloud Platform is the default cloud substrate for a large share of agent-harness deployments: Cloud Run hosts the harness runtime, Cloud Storage holds document corpora, BigQuery runs analytical workloads, and the Gemini family (accessed via Vertex AI) provides frontier inference inside the same IAM boundary. A generated harness that cannot drive GCP primitives forces the operator to maintain a separate glue layer — exactly the kind of weekend work `metaharness` exists to delete.

Three capabilities are universally relevant across harness verticals:

1. **Cloud Storage** — list buckets and objects, read metadata, generate signed URLs for secure agent-accessible downloads. These are the read path for any RAG or document-processing harness.
2. **BigQuery** — run parameterised SQL against structured data; the dry-run feature returns bytes-processed and cost estimates before a query touches quota, making it safe to expose to an autonomous agent.
3. **Vertex AI / Gemini inference** — the `@google/genai` SDK (v2.8.0, the successor to the deprecated `@google-cloud/vertexai` removed June 2026) provides `generateContent`, streaming, and function-calling over Gemini 2.x models on the Vertex endpoint, authenticated via Application Default Credentials — no API key is required inside a GCP project.

These three together cover the most common GCP use-case for an agent harness (retrieve data → query it → reason over it → verify output). The BigQuery dry-run capability is a natural fit for the ADR-050 verification gate: the verifier agent can re-run the query in dry-run mode to confirm row/byte estimates match what the planner proposed, before any results leave the harness.

The auth model — Application Default Credentials (ADC) — is GCP-native, works identically in Cloud Run, GKE, Compute Engine (via attached service account), and locally (via `gcloud auth application-default login` or a `GOOGLE_APPLICATION_CREDENTIALS` key file), and requires zero changes to scaffolded code when moving from local dev to production. This is the credential model GCP client libraries pick up automatically with no constructor arguments.

## Decision

### Chosen SDK packages

| Package | Version (June 2026) | Role |
|---|---|---|
| `@google-cloud/storage` | 7.21.0 | Cloud Storage read operations |
| `@google-cloud/bigquery` | 8.x | BigQuery query + dry-run |
| `@google/genai` | 2.8.0 | Vertex AI / Gemini inference via ADC |

`@google-cloud/vertexai` is NOT used. It was deprecated on 2025-06-24 and removed on 2026-06-24. The current canonical package for Gemini inference on Vertex AI is `@google/genai` (the Google Gen AI SDK). To activate Vertex AI mode (ADC + project/location, no API key), set `GOOGLE_GENAI_USE_VERTEXAI=true`.

`@google-cloud/aiplatform` is not used. It is the lower-level gRPC admin client for Vertex AI platform management, not the inference path.

### Headline capability

An agent that:
1. Lists objects in a named Cloud Storage bucket (read-only, no download unless explicitly flagged).
2. Runs a parameterised BigQuery SQL query against a user-supplied dataset **in dry-run mode by default**, returning the bytes-processed estimate and sample schema; switches to live execution only when `--allow-mutations` is set.
3. Passes the query results (or dry-run schema) to a Gemini 2.x model on Vertex AI for natural-language interpretation and recommendation.
4. Re-validates the Gemini output by re-checking the BigQuery job status and row count against the model's stated figures (the ADR-050 verification gate).

### Agent and skill design

Three specialised agents are defined inside the scaffolded harness:

| Agent | Tier | Responsibility |
|---|---|---|
| `gcp-planner` | Frontier (Gemini 2.0 Flash or equivalent) | Parses the operator prompt, selects which GCP capabilities to invoke, builds the query plan |
| `gcp-executor` | Cheap (Gemini 2.0 Flash Lite or haiku-class) | Calls the GCP SDK in dry-run mode (or live if opted in); formats raw API results |
| `gcp-verifier` | Cheap, deterministic | Re-reads the BigQuery job metadata and Storage object count to confirm executor claims match reality |

One slash command is provided: `/gcp-query <natural-language question about your dataset>`. The planner translates the natural-language question into parameterised SQL, the executor runs it (dry-run by default), the verifier cross-checks, and only then does the frontier tier compose the final natural-language answer.

### Tiered model routing (ADR-026)

| Tier | Model class | Used by | Rationale |
|---|---|---|---|
| Cheap | Flash Lite / haiku-class | `gcp-executor`, `gcp-verifier` | High-volume, low-reasoning work: SDK calls, JSON formatting, byte-count comparison |
| Frontier | Flash / Sonnet-class | `gcp-planner` and final answer composition | Requires semantic understanding of the operator's question and the BigQuery schema |

Routing is wired in the scaffolded `.harness/router.json`. The executor never calls the frontier tier — it routes cheap by default and only escalates if the executor returns a structured error that the planner must interpret.

### MCP policy (ADR-022 default-deny)

The scaffolded `.harness/mcp-policy.json` grants exactly the following tools, all others are denied:

```
gcp:storage:list-buckets          (read-only)
gcp:storage:list-objects          (read-only)
gcp:storage:get-object-metadata   (read-only)
gcp:bigquery:dry-run-query        (read-only by default)
gcp:bigquery:run-query            (mutations — requires allow-mutations flag)
gcp:bigquery:get-job-status       (read-only, used by verifier)
gcp:genai:generate-content        (inference only, no model training or deployment)
```

An audit log of every MCP tool invocation is written to `.harness/audit/gcp-<timestamp>.jsonl`. No other MCP surface is exposed. The policy file is emitted at scaffold time; operators can narrow it further but cannot add tools outside this list without editing the policy and restarting the harness.

### Auth model

Authentication uses Application Default Credentials throughout. No credential values are written into any scaffolded file. The three env vars documented in the scaffold's `.env.example` are:

```
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json   # or omit if running on GCP
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_GENAI_USE_VERTEXAI=true
```

When running on Cloud Run, GKE, or Compute Engine, `GOOGLE_APPLICATION_CREDENTIALS` is not needed; the attached service account is picked up automatically by the client libraries. For local development, `gcloud auth application-default login` writes a user credential file that ADC finds automatically (no env var required). The `GOOGLE_APPLICATION_CREDENTIALS` env var is documented as the explicit override path for CI/CD pipelines using a service-account JSON key.

### Safety gates

- **Read-only by default.** The executor only calls `gcp:bigquery:dry-run-query` and Storage list/metadata operations unless `--allow-mutations` is passed at scaffold time or at runtime via the `/gcp-query --live` flag. BigQuery dry-run returns `totalBytesProcessed` and schema but executes no query and incurs zero query cost.
- **No file downloads by default.** `gcp:storage:get-object-metadata` is granted; downloading object bytes is not in the MCP policy unless the operator adds it.
- **No model training, dataset creation, or IAM mutation** are in the MCP policy.
- **Billing alert.** The planner reads `totalBytesProcessed` from the dry-run result and emits a cost estimate (at standard BigQuery on-demand pricing of $6.25/TB) before asking the operator to confirm live execution.
- **BigQuery Sandbox compatibility.** The scaffold's quickstart guide notes that BigQuery Sandbox (free tier, no billing account required, 1 TB/month of query processing) is sufficient for all dry-run operations and most demonstration queries. Operators are directed to the BigQuery Sandbox documentation as the zero-cost path.

## Consequences

### Positive

- Operators get a working, authenticated GCP agent in one `npx` command, with no credential values in files and no accidental spend.
- The BigQuery dry-run gate makes it safe to expose SQL generation to a frontier model: worst case is a bad query that costs $0 to validate.
- The three-agent (planner / executor / verifier) topology concretely demonstrates ADR-050 verification-gated output with a real platform read-back.
- ADC means the same scaffolded code works locally, in Cloud Run, and in GitHub Actions (via Workload Identity Federation) with no code changes.
- The `@google/genai` migration from `@google-cloud/vertexai` is handled inside the scaffold — operators who previously used the deprecated package get the correct current import pattern.

### Honest limitations

- The MCP policy stubs (`gcp:storage:*`, `gcp:bigquery:*`, `gcp:genai:*`) require the `@metaharness/mcp-gcp` adapter to be available; the example documents this dependency and falls back to direct Node.js SDK calls if the adapter is absent, at the cost of losing the audit log.
- BigQuery Sandbox enforces a 60-day table expiration on all datasets; the scaffold notes this limitation and recommends using `bigquery-public-data` datasets for demonstrations.
- Gemini model availability on Vertex AI is regional. The scaffold defaults to `us-central1`; operators in other regions must update `GOOGLE_CLOUD_LOCATION`.
- `@google/genai` v2.8.0 uses the terminology "Gemini Enterprise Agent Platform" for the Vertex AI endpoint internally. Both `GOOGLE_GENAI_USE_VERTEXAI=true` and `GOOGLE_GENAI_USE_ENTERPRISE=true` are documented as accepted env vars; the scaffold uses `GOOGLE_GENAI_USE_VERTEXAI=true` which is the more widely documented form.
- **This example is not a production-ready GCP deployment.** It is an illustrative scaffold. It does not configure VPC Service Controls, Private Google Access, CMEK, or Assured Workloads. It is not certified for any compliance framework (SOC 2, ISO 27001, FedRAMP). Operators deploying to production must perform their own security review.
