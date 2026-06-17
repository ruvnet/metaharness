# @metaharness/example-bio

**One command to scaffold a bioinformatics agent harness — gene lookup, PubMed literature retrieval, and genomic sequence fetch, wired to NCBI E-utilities and the Ensembl REST API.**

> **Illustrative output notice.** The responses shown in this README are representative examples of what the scaffolded harness produces against the live NCBI and Ensembl public APIs. Actual results depend on the current state of those databases. This package is for educational and prototyping purposes only — see the [Safety](#safety) section.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-bio.svg)](https://www.npmjs.com/package/@metaharness/example-bio)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-bio.svg)](https://www.npmjs.com/package/@metaharness/example-bio)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![Built with metaharness](https://img.shields.io/badge/built%20with-metaharness-blueviolet)](https://github.com/ruvnet/agent-harness-generator)

---

## Introduction

`@metaharness/example-bio` scaffolds a ready-to-run AI agent harness pre-wired to two free, public bioinformatics APIs:

- **NCBI E-utilities** (`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/`) — 38 Entrez databases including PubMed, Gene, Nucleotide, Protein, and PMC. No subscription required; an optional free API key raises the rate limit from 3 to 10 requests per second.
- **Ensembl REST API** (`https://rest.ensembl.org`) — genomic reference data for hundreds of species: gene lookup by symbol or stable ID, canonical sequences, variant effect predictions, homology, and coordinate mapping. No authentication required.

The generated harness ships three specialised agents (planner, executor, verifier), two `/slash` commands, tiered model routing (cheap tier for raw API calls, frontier tier for synthesis), an MCP default-deny policy scoped to the two API hosts, and a verification gate that re-checks every result before surfacing it to the user.

**What it is NOT:**
- Not a clinical tool. It queries reference databases only; it does not process individual patient data.
- Not HIPAA/GDPR-compliant out of the box for clinical use.
- Not a replacement for curated bioinformatics pipelines (GATK, Nextflow, Snakemake, etc.).
- Not affiliated with NCBI/NLM, NIH, or the Wellcome Sanger Institute/EBI.

---

## Features

| Capability | What the harness does |
|---|---|
| **PubMed literature search** | `/biosearch <query>` fans out to NCBI ESearch + ESummary, returns up to 10 papers with PMID, DOI, title, authors, and abstract snippet |
| **Gene record retrieval** | `/biogene <symbol-or-id>` resolves a gene symbol (e.g. BRCA1) to an NCBI Gene UID, fetches the full gene summary, and cross-references the Ensembl stable ID |
| **Genomic sequence fetch** | Given an Ensembl gene ID, the executor retrieves the canonical coding sequence in FASTA format |
| **Tiered model routing** | Raw API calls skip the LLM entirely (Tier 1); JSON extraction uses a cheap Haiku-class model (Tier 2); synthesis of abstracts into a research brief uses a frontier Sonnet/Opus model (Tier 3) |
| **MCP default-deny** | `.harness/mcp-policy.json` grants `fetch` only to `eutils.ncbi.nlm.nih.gov` and `rest.ensembl.org`; all other tools and hosts are blocked |
| **Verification gate** | `bio-verifier` re-fetches the primary identifier (PMID, Gene UID, Ensembl ID) from the canonical endpoint and confirms the executor's result before marking done |
| **Rate-limit awareness** | Token-bucket throttler: max 3 req/s without NCBI key, 10 req/s with key; Ensembl 429s are handled with `Retry-After` backoff |
| **All-host scaffold** | `--host <id>` (default `claude-code`) or `--host all` emits config for every supported host |
| **Audit log** | Every outbound API call is appended to `.harness/audit.jsonl` |

---

## Quickstart

```bash
npx @metaharness/example-bio@latest my-bio-bot
cd my-bio-bot
npm install
npm run doctor
```

This creates `my-bio-bot/` pre-wired for Claude Code (default host). To scaffold for a different host:

```bash
npx @metaharness/example-bio@latest my-bio-bot --host codex
npx @metaharness/example-bio@latest my-bio-bot --host github-actions
npx @metaharness/example-bio@latest my-bio-bot --host all   # every supported host
```

Supported hosts: `claude-code`, `codex`, `copilot`, `github-actions`, `hermes`, `openclaw`, `opencode`, `pi-dev`, `rvm`.

---

## Configuration

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NCBI_API_KEY` | Optional | none | Raises NCBI rate limit from 3 to 10 req/s. Get one free at your [NCBI account settings](https://www.ncbi.nlm.nih.gov/account/) → API Key Management. |
| `NCBI_TOOL_NAME` | Recommended | `metaharness-bio` | Identifies your software to NCBI. Sent as `tool=` query param on all E-utilities calls. Must contain no spaces. |
| `NCBI_EMAIL` | Recommended | none | Your contact email. Sent as `email=` param. Required by NCBI to unblock an IP if rate limits are violated. |
| `ENSEMBL_BASE_URL` | Optional | `https://rest.ensembl.org` | Override to `https://grch37.rest.ensembl.org` if your gene coordinates are on the older GRCh37/hg19 assembly. |
| `BIO_RETMAX` | Optional | `5` | Maximum number of NCBI results to return per query (maps to the `retmax` E-utilities parameter). Raise to up to 10,000 for bulk workflows; the harness rate-limits automatically. |

Set these in your shell or in a `.env` file (never committed):

```bash
export NCBI_API_KEY=your_key_here
export NCBI_TOOL_NAME=my-research-agent
export NCBI_EMAIL=you@example.com
```

### No dedicated test/sandbox endpoint

NCBI E-utilities and the Ensembl REST API offer only production endpoints — there is no separate sandbox URL. The harness stays safe by:

1. Using only read-only GET/POST queries (no NCBI endpoint writes data).
2. Defaulting to `retmax=5` to minimise unnecessary load.
3. Using known stable identifiers for integration checks: Gene ID 672 (BRCA1), Ensembl ID ENSG00000012048, PMID 7987400.
4. The `npm run doctor` command runs these smoke queries to confirm connectivity without triggering significant load.

---

## Usage

### Slash commands

```
/biosearch <query>
```
Search PubMed for up to `BIO_RETMAX` papers matching `<query>`. Returns PMIDs, titles, authors, publication dates, DOIs, and a frontier-model synthesis of the top findings.

```
/biogene <symbol-or-ncbi-gene-id>
```
Resolve a gene symbol (e.g. `BRCA1`, `TP53`, `EGFR`) or NCBI Gene ID (e.g. `672`) to a full gene record including function summary, genomic location, RefSeq IDs, and the Ensembl stable gene ID with canonical sequence length.

### Representative natural-language prompts

After `npm start` (or invoking your chosen host):

```
Search PubMed for recent papers on CRISPR base editing off-target effects and summarise the three most cited findings.

Look up the gene BRCA2 and tell me its chromosomal location, the Ensembl gene ID, and the length of the canonical transcript.

Fetch the coding sequence of ENSG00000139618 and tell me the first 60 nucleotides.

Find all NCBI Gene IDs for the symbol ACE2 and cross-reference them with Ensembl for the human genome.
```

---

## Safety

- **Read-only by nature.** All NCBI E-utilities calls (`esearch`, `efetch`, `esummary`, `elink`) and all Ensembl REST calls are HTTP GET or POST queries that retrieve data. Neither API exposes mutation endpoints. No data is written to external services.
- **No patient data.** This harness queries public reference databases: literature abstracts, gene annotations, and reference genome sequences. Individual clinical or genomic data from patients is never sent to or retrieved from these APIs.
- **MCP default-deny.** The scaffolded `.harness/mcp-policy.json` allows `fetch` only to `eutils.ncbi.nlm.nih.gov` and `rest.ensembl.org`. All other network destinations and MCP tools are blocked unless you explicitly extend the policy.
- **Rate-limit compliance.** The executor enforces a token-bucket throttle. If NCBI returns HTTP 429, the harness backs off and retries. Ensembl's `Retry-After` header is always respected.
- **Verification gate.** The `bio-verifier` agent re-fetches every primary result identifier from the authoritative API endpoint before the answer is surfaced. This prevents hallucinated PMIDs or Gene IDs from reaching the user.
- **Secrets in env only.** `NCBI_API_KEY` is read from the environment at runtime. It is never written to any scaffolded file.

> **Not for clinical use.** This example is illustrative and educational. Any downstream use involving clinical genomic interpretation, diagnostic reporting, or medical decision support requires applicable regulatory compliance (HIPAA, GDPR, EU IVD Regulation, FDA 510(k), etc.). This package is not a medical device and is not certified or validated for clinical or diagnostic use.

---

## How it works

### Agents

```
bio-planner   →  bio-executor  →  bio-verifier
    |                 |                 |
 Classify          Drive API         Re-fetch
 intent,           calls with        primary ID,
 select tier       throttling        confirm match
```

- **bio-planner** parses the user query, classifies intent (literature search / gene lookup / sequence fetch), emits a structured task list, and selects the routing tier for the synthesis step.
- **bio-executor** makes all outbound API calls — NCBI E-utilities via `node-ncbi` (for PubMed) and raw `fetch` (for Gene, Nucleotide, Ensembl REST) — applying rate limiting and backoff. Caches raw responses to `.harness/cache/`.
- **bio-verifier** takes the primary identifier(s) returned by the executor (PMID, Gene UID, or Ensembl stable ID), re-fetches them from the canonical endpoint, and confirms the returned record is consistent before marking the task done.

### Routing tiers

| Tier | What runs | Examples |
|---|---|---|
| 1 — Direct API | No LLM; executor calls API directly | ESearch for a known symbol, ESummary for a known PMID, Ensembl lookup/id |
| 2 — Cheap model (Haiku-class) | Lightweight extraction | Parse ESummary XML/JSON, extract title/author/DOI fields, format FASTA header |
| 3 — Frontier model (Sonnet/Opus) | Synthesis and reasoning | Summarise 5–10 abstracts into a research brief, interpret gene function in context of user question |

### MCP policy — granted tools

The scaffolded `.harness/mcp-policy.json` grants exactly:

| Tool | Scope | Purpose |
|---|---|---|
| `fetch` (GET/POST) | `eutils.ncbi.nlm.nih.gov`, `rest.ensembl.org`, `grch37.rest.ensembl.org` | All NCBI E-utilities and Ensembl REST calls |
| `read_file` | `.harness/cache/**` | Read locally cached API responses |
| `write_file` | `.harness/cache/**` | Cache fetched sequences and abstracts |
| `audit_log` | `.harness/audit.jsonl` | Append every outbound API call for traceability |

All other tools and all other network destinations are denied by default.

---

## Links

- NCBI E-utilities documentation: https://www.ncbi.nlm.nih.gov/books/NBK25501/
- NCBI E-utilities quick start: https://www.ncbi.nlm.nih.gov/books/NBK25500/
- NCBI API key registration: https://www.ncbi.nlm.nih.gov/account/
- NCBI E-utilities usage guidelines: https://www.ncbi.nlm.nih.gov/books/NBK25497/
- `node-ncbi` npm package: https://www.npmjs.com/package/node-ncbi
- `node-ncbi` GitHub: https://github.com/CAYdenberg/node-ncbi
- Ensembl REST API: https://rest.ensembl.org/
- Ensembl REST rate limits: https://github.com/Ensembl/ensembl-rest/wiki/Rate-Limits
- ADR-069 (this design): https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-069-example-bio-bioinformatics-sdk-showcase.md
- ADR-051 (examples program): https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md
- metaharness generator: https://github.com/ruvnet/agent-harness-generator
