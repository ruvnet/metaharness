# ADR-069: example-bio — Bioinformatics SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Bioinformatics is one of the most data-rich and query-intensive domains an AI agent
can address. NCBI (National Center for Biotechnology Information) hosts 38 Entrez
databases — PubMed, Gene, Nucleotide, Protein, PMC, and more — publicly queryable
via the free E-utilities REST API. Ensembl provides complementary genomic reference
data (gene lookup by stable identifier or symbol, sequences, variant effect
predictions, homology, and coordinate mapping) via its own free public REST API at
`https://rest.ensembl.org`. Neither service requires a paid subscription; NCBI's
rate limits are relaxed from 3 req/s to 10 req/s simply by providing an API key,
and Ensembl allows 55,000 requests per rolling hour (~15 req/s) per IP with no key
required.

A metaharness wired to these two APIs can autonomously:
- Resolve a gene name or NCBI Gene ID to a curated record and canonical sequence
- Retrieve PubMed abstracts, author lists, PMIDs, and DOIs for a research topic
- Cross-reference gene identifiers between NCBI Gene, Ensembl, and RefSeq
- Fetch genomic sequences (FASTA format) for a given gene or region via Ensembl
- Look up functional annotations, homologues, and variant effects

No equivalent "showcase" currently exists in the metaharness catalog. The
bioinformatics vertical is also representative of the "read-only public API with
rate-limit awareness" pattern: E-utilities and Ensembl REST expose no write
operations and carry no patient data, so the safety posture is simpler than the
FHIR or ads examples while still illustrating tiered routing, verification, and MCP
default-deny in a real scientific context.

The primary npm wrapper chosen for NCBI is **`node-ncbi`** (`npm install node-ncbi`).
It reads the `NCBI_API_KEY` environment variable automatically since v0.6.0, exposes
promise-based PubMed methods (`pubmed.search`, `pubmed.abstract`, `pubmed.summary`,
`pubmed.cites`, `pubmed.citedBy`, `pubmed.fulltext`, `pubmed.isOa`), and is the most
actively maintained CJS wrapper for NCBI E-utilities in the npm registry.

For gene-level queries (Gene database ESearch + EFetch) and Ensembl REST calls, the
harness uses the Node.js built-in `fetch` API (available since Node 18, required at
>=20 by this package) rather than a dedicated Ensembl npm client — no such package
with adequate current maintenance exists in the npm registry as of June 2026. Direct
`fetch` calls against `https://rest.ensembl.org` with `Content-Type: application/json`
headers are the documented and idiomatic approach for all languages.

## Decision

### Chosen SDKs and why

| Service | Approach | Package / URL | Why |
|---|---|---|---|
| NCBI PubMed | `node-ncbi` npm wrapper | `npm install node-ncbi` | Only maintained CJS promise wrapper that reads `NCBI_API_KEY` automatically |
| NCBI Gene, Nucleotide, Protein | Raw E-utilities via `fetch` | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/` | `node-ncbi` is PubMed-focused; Gene/Nucleotide use the same base URL with `esearch.fcgi`, `efetch.fcgi`, `esummary.fcgi` |
| Ensembl genomic data | Direct `fetch` against REST API | `https://rest.ensembl.org` | No maintained npm client; fetch + JSON is the officially documented pattern for all languages |

### Headline capabilities showcased

1. **PubMed literature search** — `/biosearch <query>` triggers a PubMed ESearch,
   returns ranked abstracts, PMIDs, and DOIs; a frontier-tier agent synthesises a
   brief summary of the top findings.
2. **Gene record retrieval** — `/biogene <symbol-or-id>` resolves a human gene
   symbol (e.g. BRCA1) to an NCBI Gene UID via ESearch, fetches the Gene record
   summary via ESummary, then cross-references to an Ensembl stable ID via a
   `lookup/symbol` call for sequence and location data.
3. **Sequence fetch** — given an Ensembl gene ID, the executor agent retrieves the
   canonical coding sequence in FASTA format from Ensembl `sequence/id/<id>`.

### Agent / skill design

| Role | Agent name | Responsibility |
|---|---|---|
| Planner | `bio-planner` | Parses the user query; classifies intent (literature vs gene vs sequence); emits a structured task list; selects tier |
| Executor | `bio-executor` | Drives the rate-limited API calls; applies exponential backoff on 429; assembles raw results |
| Verifier | `bio-verifier` | Re-fetches the primary identifier returned by the executor against the canonical API endpoint; confirms the record exists and the returned data matches before marking done |

Slash commands:
- `/biosearch <query>` — PubMed literature fan-out (up to 10 results)
- `/biogene <symbol-or-ncbi-id>` — gene record + Ensembl cross-reference

### Routing tiers (ADR-026)

| Tier | Model | Used for |
|---|---|---|
| 1 (booster / skip-LLM) | direct API call | Raw ESearch / ESummary / EFetch / Ensembl lookup — no LLM involved |
| 2 (cheap) | Haiku-class | Extraction: parse JSON payloads, format PMID lists, extract gene fields |
| 3 (frontier) | Sonnet/Opus-class | Synthesis: summarise PubMed abstracts, interpret gene function, compose the final user-facing report |

The executor drives Tier 1 calls directly; the bio-planner classifies complexity
and routes the synthesis step to Tier 3 only when the result set exceeds a
configurable threshold (default: >3 papers or a gene with >5 cross-references).

### MCP policy — granted tools only

File: `.harness/mcp-policy.json`

Granted tools (default-deny, all others blocked):

```json
{
  "version": 1,
  "defaultAction": "deny",
  "rules": [
    {
      "tool": "fetch",
      "comment": "NCBI E-utilities (eutils.ncbi.nlm.nih.gov) and Ensembl REST (rest.ensembl.org) — read-only GET/POST",
      "allowedHostPatterns": [
        "eutils.ncbi.nlm.nih.gov",
        "rest.ensembl.org",
        "grch37.rest.ensembl.org"
      ],
      "methods": ["GET", "POST"],
      "action": "allow"
    },
    {
      "tool": "read_file",
      "comment": "Read FASTA or JSON results cached locally",
      "action": "allow"
    },
    {
      "tool": "write_file",
      "comment": "Cache fetched sequences/abstracts to .harness/cache/",
      "pathPrefix": ".harness/cache/",
      "action": "allow"
    },
    {
      "tool": "audit_log",
      "comment": "Append every API call to .harness/audit.jsonl",
      "action": "allow"
    }
  ]
}
```

All other MCP tools — shell execution, arbitrary network, file system outside
`.harness/cache/` — are denied by default.

### Auth model

| Credential | Env var | Required | Where to obtain |
|---|---|---|---|
| NCBI API key | `NCBI_API_KEY` | Optional (raises rate limit from 3 to 10 req/s) | NCBI account → Account Settings → API Key Management |
| NCBI tool identifier | `NCBI_TOOL_NAME` | Recommended | Any non-space string identifying your software; sent as `tool=` param |
| NCBI contact email | `NCBI_EMAIL` | Recommended | Your email; sent as `email=` param; required for IP unblocking |
| Ensembl | none | Not required | Public free API, no key |

`node-ncbi` appends `api_key` automatically when `NCBI_API_KEY` is set. For raw
`fetch` calls to NCBI Gene/Nucleotide, the executor constructs the `api_key`,
`tool`, and `email` URL parameters from the above env vars.

### Safety gates

- **All API calls are read-only GET/POST queries** — NCBI E-utilities and Ensembl
  REST expose no mutation endpoints. There are no writes, charges, sends, or
  actuations to gate.
- **No patient data** — this example targets reference databases (gene annotations,
  literature, reference sequences). No clinical or individual genomic data is
  processed.
- **Rate-limit compliance by default** — the executor wraps all outbound calls in a
  token-bucket throttler: ≤3 req/s without key, ≤10 req/s with key for NCBI;
  ≤15 req/s for Ensembl. On HTTP 429, the executor respects `Retry-After` before
  retrying.
- **No sandbox/test endpoint exists** — NCBI and Ensembl offer only production
  endpoints. Safety comes from the read-only nature of all calls and from the
  `tool` + `email` registration reducing block risk. The harness defaults to
  `retmax=5` (5 results) to minimise load; a `--retmax <n>` flag raises this.
- **Verification gate** — the bio-verifier re-fetches the primary identifier
  (PMID, Gene UID, or Ensembl stable ID) from the canonical endpoint and checks
  that the record returned by the executor matches before the result is surfaced
  to the user. This catches stale cache hits and malformed responses.

## Consequences

### Positive

- Gives researchers and bioinformaticians a one-command starting point for an
  agent that can query 38 NCBI databases and the full Ensembl genome reference,
  all read-only and free.
- Demonstrates the "no-sandbox, read-only-by-nature" safety pattern, which is
  distinct from the Stripe/FHIR/IoT examples and rounds out the catalog.
- Tiered routing is well-suited here: raw API calls (Tier 1) are cheap and fast;
  synthesis (Tier 3) adds genuine value over raw JSON dumps.
- No secrets are required to run at all (Ensembl is keyless; NCBI works at 3
  req/s without a key), lowering the barrier for first-time users.

### Limitations

- `node-ncbi` is primarily PubMed-focused; Gene, Nucleotide, and Protein database
  queries use raw `fetch` against the E-utilities base URL. The harness includes
  helper functions for these to avoid boilerplate in user-extended harnessses.
- `node-ncbi` is a CommonJS module; the harness's `bin/scaffold.mjs` uses dynamic
  `import()` to load it within an ESM context.
- Neither NCBI E-utilities nor Ensembl REST provides a dedicated sandbox endpoint.
  Test safely by using small `retmax` values and confirming known stable identifiers
  (e.g. Gene ID 672 for BRCA1, Ensembl ID ENSG00000012048).
- The Ensembl REST API's GRCh37 endpoint (`https://grch37.rest.ensembl.org`) uses
  the older human reference genome assembly; the default endpoint
  (`https://rest.ensembl.org`) uses the current GRCh38. Users working with legacy
  coordinates should set `ENSEMBL_BASE_URL=https://grch37.rest.ensembl.org`.
- This example is not a clinical tool and carries no regulatory certification.
  It is illustrative only.

### Not-for-production disclaimer

This example accesses public reference databases (NCBI, Ensembl) and does not
process individual patient data. However, any downstream use involving clinical
genomic data, diagnostic interpretation, or medical decision support is outside
the scope of this showcase and requires applicable regulatory compliance (e.g.
HIPAA, GDPR, CE/FDA for diagnostic software). The example is provided for
educational and prototyping purposes only.
