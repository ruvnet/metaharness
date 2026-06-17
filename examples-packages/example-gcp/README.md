# @metaharness/example-gcp

**A one-command MetaHarness scaffold wired to Google Cloud Storage, BigQuery, and Vertex AI (Gemini) — read-only and safe by default.**

> **Illustrative output disclaimer.** This package scaffolds an example agent harness for demonstration and learning purposes. All code, queries, and AI-generated outputs are illustrative. No compliance, certification, or production readiness is implied or guaranteed. Do not use the scaffolded harness for regulated workloads (PHI, PCI, export-controlled data) without a full independent security review.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-gcp?label=%40metaharness%2Fexample-gcp&color=blue)](https://www.npmjs.com/package/@metaharness/example-gcp)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-gcp)](https://www.npmjs.com/package/@metaharness/example-gcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![built with metaharness](https://img.shields.io/badge/built%20with-metaharness-8A2BE2)](https://github.com/ruvnet/agent-harness-generator)

---

## What this is (and is not)

This package scaffolds a **MetaHarness agent harness** pre-wired to three Google Cloud Platform services:

- **Cloud Storage** (`@google-cloud/storage` v7.x) — list buckets, list objects, read object metadata.
- **BigQuery** (`@google-cloud/bigquery` v8.x) — validate and estimate SQL queries in dry-run mode; run live queries only when you explicitly opt in.
- **Vertex AI / Gemini inference** (`@google/genai` v2.x) — generate content, stream responses, and call functions against Gemini 2.x models on Vertex AI, authenticated via Application Default Credentials.

It is **not** a production GCP deployment tool. It is not a Terraform/IaC generator. It does not provision resources, create datasets, write to Storage, or modify IAM. Mutations require an explicit opt-in flag.

---

## Features

| MetaHarness capability | How it is demonstrated on GCP |
|---|---|
| **Tiered model routing** | Cheap tier (Flash Lite) drives SDK calls and verifier checks; frontier tier (Flash / Sonnet) handles query planning and final answer composition |
| **MCP default-deny** | `.harness/mcp-policy.json` grants exactly 7 scoped GCP tools; all others are denied; every invocation is audit-logged |
| **Slash command** | `/gcp-query <question>` translates a natural-language question into parameterised SQL, runs a dry-run, verifies, then answers |
| **Specialized agents** | `gcp-planner` (frontier, query design) + `gcp-executor` (cheap, SDK calls) + `gcp-verifier` (cheap, deterministic read-back) |
| **Verification gate** | Verifier re-reads BigQuery job metadata and Storage object count before the harness reports output as done |
| **Read-only / dry-run default** | BigQuery queries run with `dryRun: true`; Storage operations are list/metadata only; no bytes are downloaded or written |
| **Cross-host scaffold** | `--host all` emits configs for all 9 supported hosts (claude-code, codex, copilot, github-actions, hermes, openclaw, opencode, pi-dev, rvm) |

---

## Quickstart

```bash
npx @metaharness/example-gcp@latest my-gcp-bot
cd my-gcp-bot
npm install
npm run doctor
```

The `doctor` command checks that your GCP credentials are resolvable, that the `GOOGLE_CLOUD_PROJECT` env var is set, and that `@google/genai` can reach the Vertex AI endpoint in the configured region.

To scaffold for a specific host:

```bash
npx @metaharness/example-gcp@latest my-gcp-bot --host github-actions
```

To scaffold for all supported hosts at once:

```bash
npx @metaharness/example-gcp@latest my-gcp-bot --host all
```

---

## Configuration

### Required environment variables

Set these before running `npm run doctor` or invoking the harness.

| Variable | Purpose | How to obtain |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | GCP project ID | [Google Cloud Console](https://console.cloud.google.com/) — top of any page |
| `GOOGLE_CLOUD_LOCATION` | Region for Vertex AI inference | e.g. `us-central1`; see [Vertex AI regions](https://cloud.google.com/vertex-ai/docs/general/locations) |
| `GOOGLE_GENAI_USE_VERTEXAI` | Enables Vertex AI mode in `@google/genai` (uses ADC, not an API key) | Set to `true` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a service-account JSON key file | [Create a service account](https://cloud.google.com/iam/docs/creating-managing-service-accounts) and download a key — **omit this variable when running on Cloud Run, GKE, or GCE** where the attached service account is used automatically |

These variables are documented in the scaffolded `.env.example`. They are never written into source files.

### Credential options

**Option 1 — Local development (recommended for experimentation):**

```bash
gcloud auth application-default login
```

This writes a user credential file that all GCP client libraries find automatically. No service-account key or env var is needed.

**Option 2 — Service account key (CI/CD pipelines):**

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json
```

**Option 3 — Workload Identity Federation (production GitHub Actions):**

Use [google-github-actions/auth](https://github.com/google-github-actions/auth) in your workflow. No key file is required.

### BigQuery Sandbox (zero-cost testing)

BigQuery offers a [free Sandbox tier](https://cloud.google.com/bigquery/docs/sandbox): 10 GB active storage and 1 TB of query processing per month, no billing account or credit card required. The `/gcp-query` slash command works against Sandbox projects and against public datasets in `bigquery-public-data`. Sandbox tables auto-expire after 60 days; use public datasets for demonstrations that must persist.

### Enabling live mutations (opt-in)

By default every BigQuery query runs with `dryRun: true`. To enable live query execution:

```bash
# at scaffold time
npx @metaharness/example-gcp@latest my-gcp-bot --allow-mutations

# or at runtime inside the harness
/gcp-query --live "SELECT COUNT(*) FROM my_dataset.my_table"
```

The harness will display the estimated bytes-processed (at standard BigQuery on-demand pricing of $6.25/TB) and request explicit confirmation before running the live query.

---

## Usage

### Slash command

```
/gcp-query <natural-language question about your GCP data>
```

Example prompts:

```
/gcp-query How many rows are in the bigquery-public-data.usa_names.usa_1910_2013 table?
/gcp-query List all objects in my-bucket that were modified in the last 7 days
/gcp-query Summarise the top 10 states by baby name count in the USA names dataset
```

When run without `--live`, the harness returns: the generated SQL, the dry-run bytes-processed estimate, the schema, and a Gemini-authored natural-language interpretation of what the query would return — all without touching your query quota.

### Representative agent interaction

```
You: /gcp-query What are the most common names in Texas from the USA names dataset?

gcp-planner  → SQL: SELECT name, SUM(number) AS total FROM `bigquery-public-data.usa_names.usa_1910_2013`
               WHERE state = 'TX' GROUP BY name ORDER BY total DESC LIMIT 10
gcp-executor → dry-run: 19.6 MB would be processed (~$0.00012 at on-demand pricing)
gcp-verifier → confirmed: job state DONE (dry-run), schema [name STRING, total INTEGER]
gcp-planner  → "Based on the dry-run schema, this query would return the top 10 names in Texas
               ordered by total count. Run with --live to see actual results."
```

---

## Safety

- **No secrets in scaffolded files.** The scaffold never writes credential values. `.env.example` documents variable names only.
- **Read-only by default.** Without `--allow-mutations`, the MCP policy denies `gcp:bigquery:run-query`; only `gcp:bigquery:dry-run-query` is reachable.
- **No Storage downloads by default.** `gcp:storage:get-object-metadata` is granted; reading object bytes is not in the default MCP policy.
- **No IAM, no resource creation, no model training.** These operations are outside the MCP policy and cannot be invoked by the scaffolded agents.
- **Audit log.** Every MCP tool call is appended to `.harness/audit/gcp-<timestamp>.jsonl`.
- **Not for production regulated workloads.** This scaffold does not configure VPC Service Controls, CMEK, Assured Workloads, or any compliance control. It is not certified for HIPAA, PCI DSS, FedRAMP, SOC 2, or ISO 27001. Treat it as an illustrative starting point only.

---

## How it works

### Three-agent topology

```
Operator prompt
      |
      v
 gcp-planner  (frontier tier)
   - parses intent
   - selects GCP capabilities
   - generates parameterised SQL
      |
      v
 gcp-executor  (cheap tier)
   - calls @google-cloud/storage for bucket/object list
   - calls @google-cloud/bigquery with dryRun: true
   - calls @google/genai generateContent for interpretation
      |
      v
 gcp-verifier  (cheap, deterministic)
   - re-reads BigQuery job.metadata.statistics.totalBytesProcessed
   - compares Storage object count to executor's reported figure
   - gates: if mismatch > 5%, returns to executor; else passes to planner
      |
      v
 gcp-planner  (frontier tier)
   - composes final natural-language answer
   - includes dry-run cost estimate if BigQuery was invoked
```

### Routing tiers

| Tier | Model class | Assigned agents | Rationale |
|---|---|---|---|
| Cheap | Flash Lite / haiku-class | `gcp-executor`, `gcp-verifier` | SDK calls, JSON formatting, numeric comparison — no deep reasoning needed |
| Frontier | Flash / Sonnet-class | `gcp-planner` (query planning, final answer) | Semantic understanding of natural-language intent and BigQuery schema |

Routing is configured in the scaffolded `.harness/router.json` and delegates to the MetaHarness routing primitive (ADR-026).

### MCP policy — granted tools

The scaffolded `.harness/mcp-policy.json` grants exactly these tools (all others are denied at the MCP gate):

| Tool | Operations | Default |
|---|---|---|
| `gcp:storage:list-buckets` | List all buckets in the project | Allowed |
| `gcp:storage:list-objects` | List objects in a named bucket | Allowed |
| `gcp:storage:get-object-metadata` | Read metadata for a named object | Allowed |
| `gcp:bigquery:dry-run-query` | Validate SQL and estimate bytes without execution | Allowed |
| `gcp:bigquery:run-query` | Execute SQL live (consumes quota) | Blocked unless `--allow-mutations` |
| `gcp:bigquery:get-job-status` | Read job metadata (used by verifier) | Allowed |
| `gcp:genai:generate-content` | Gemini inference on Vertex AI | Allowed |

### Auth flow (Application Default Credentials)

All three GCP client libraries (`@google-cloud/storage`, `@google-cloud/bigquery`, `@google/genai` in Vertex mode) pick up ADC automatically with no constructor arguments. The credential resolution order is: `GOOGLE_APPLICATION_CREDENTIALS` env var → `gcloud auth application-default` user credentials → attached service account (on GCP infrastructure). The scaffolded harness instantiates clients as:

```js
import { Storage } from '@google-cloud/storage';
import { BigQuery } from '@google-cloud/bigquery';
import { GoogleGenAI } from '@google/genai';

const storage = new Storage();                    // ADC, project from env
const bigquery = new BigQuery();                  // ADC, project from env
const ai = new GoogleGenAI();                     // ADC + GOOGLE_GENAI_USE_VERTEXAI=true
```

---

## Links

- [Cloud Storage Node.js client docs](https://googleapis.dev/nodejs/storage/latest/)
- [BigQuery Node.js client docs](https://googleapis.dev/nodejs/bigquery/latest/)
- [Google Gen AI SDK (js-genai)](https://github.com/googleapis/js-genai)
- [Application Default Credentials guide](https://cloud.google.com/docs/authentication/application-default-credentials)
- [BigQuery dry-run sample](https://cloud.google.com/bigquery/docs/samples/bigquery-query-dry-run)
- [BigQuery Sandbox (free tier)](https://cloud.google.com/bigquery/docs/sandbox)
- [ADR-053: example-gcp design record](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-053-example-gcp.md)
- [ADR-051: examples program](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md)
- [MetaHarness generator](https://github.com/ruvnet/agent-harness-generator)
