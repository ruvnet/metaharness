# @metaharness/example-fhir

> One-command FHIR R4 agent harness — reads Patient / Observation / Device from a public sandbox EHR, drives multi-agent clinical queries, and verifies every result before reporting done.

> ⚠️ **Illustrative output.** Transcripts and sample output shown in this README are representative examples, not captured from a live run — actual output depends on your environment, models, and the state of the public sandbox. Run the commands to see real results.

> **NOT A MEDICAL DEVICE. NOT FOR CLINICAL USE. NOT HIPAA-COMPLIANT.** This scaffold is for educational and integration-prototyping purposes only. See the [Safety](#safety) section for the full disclaimer.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-fhir?label=%40metaharness%2Fexample-fhir)](https://www.npmjs.com/package/@metaharness/example-fhir)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-fhir)](https://www.npmjs.com/package/@metaharness/example-fhir)
[![license](https://img.shields.io/npm/l/@metaharness/example-fhir)](LICENSE)
[![node](https://img.shields.io/node/v/@metaharness/example-fhir)](package.json)
[![built with metaharness](https://img.shields.io/badge/built%20with-metaharness-6366f1)](https://www.npmjs.com/package/metaharness)

---

## Introduction

`@metaharness/example-fhir` scaffolds a ready-to-run agent harness pre-wired to the [fhir-kit-client](https://github.com/Vermonster/fhir-kit-client) SDK (SMART on FHIR R4, ESM, Node 18+). It demonstrates how the metaharness capability primitives — tiered model routing, MCP default-deny, slash commands, multi-agent coordination, and verification-gated output — apply to health and medical-device data workflows.

**What it IS:**
- A scaffold for prototyping FHIR R4 agent workflows on public sandboxes
- A reference architecture for health-tech teams evaluating agent harnesses
- A copy-paste starting point for integrating `fhir-kit-client` into a generated harness

**What it is NOT:**
- A medical device, a clinical decision-support tool, or a HIPAA-compliant system
- A substitute for professional medical advice, diagnosis, or treatment
- A production-ready EHR integration (you must harden auth, add PHI controls, and meet your regulatory obligations before any clinical use)

---

## Features

| metaharness capability | How this example demonstrates it |
|---|---|
| **Tiered model routing** | `fhir-planner` and `fhir-verifier` use Tier 2 (cheap model) for query decomposition, pagination, and read-back checks; `fhir-executor` escalates to Tier 3 (Sonnet/Opus) for cross-resource clinical narrative synthesis |
| **MCP default-deny** | `.harness/mcp-policy.json` grants only `fhir.read`, `fhir.search`, `fhir.nextPage`, `fhir.operation`, `fhir.smartAuthMetadata`, `fhir.capabilityStatement`; all write tools (`create`, `update`, `patch`, `delete`, `batch`, `transaction`) are explicitly denied unless `FHIR_ALLOW_WRITE=true` |
| **Slash command** | `/fhir-query` drives the full planner → executor → verifier pipeline from a single prompt |
| **Specialized agents** | Three agents: `fhir-planner` (decomposes queries), `fhir-executor` (fans out FHIR calls, synthesises), `fhir-verifier` (read-back gate) |
| **Verification gate** | `fhir-verifier` re-reads each cited resource by ID and confirms the response before output is presented as done (ADR-050) |
| **Sandbox / read-only by default** | Default `FHIR_BASE_URL` is the open HAPI R4 test server — no registration, no PHI, no mutations possible without explicit opt-in |

**FHIR-specific capabilities the harness showcases:**

- `Patient` search and read — demographics, identifiers, contact info
- `Observation` fan-out — vital signs, lab results, device measurements, filtered by `category` and `date`
- `Device` read — implanted and wearable medical device records linked to a patient
- Paginated result traversal via `client.nextPage({ bundle })`
- SMART authorization metadata discovery via `client.smartAuthMetadata()` (for Mode 2 auth)
- FHIR `$everything` operation for full patient record retrieval
- Tiered synthesis: cheap model extracts structured fields; frontier model narrates clinical context

---

## Quickstart

```bash
npx @metaharness/example-fhir@latest my-fhir-bot
cd my-fhir-bot && npm install && npm run doctor
```

`npm run doctor` checks that `fhir-kit-client` is installed, the default sandbox is reachable, and the MCP policy is correctly wired. No credentials are needed for the open sandbox path.

### Optional: choose a host

```bash
# Scaffold for GitHub Actions (CI/CD pipeline)
npx @metaharness/example-fhir@latest my-fhir-bot --host github-actions

# Scaffold for all supported hosts at once
npx @metaharness/example-fhir@latest my-fhir-bot --host all
```

Supported hosts: `claude-code` (default), `codex`, `copilot`, `github-actions`, `hermes`, `openclaw`, `opencode`, `pi-dev`, `rvm`.

---

## Configuration

### Mode 1 — Open sandbox (default, no credentials)

The scaffold works out of the box pointing at the [HAPI FHIR public R4 server](https://hapi.fhir.org/baseR4). No registration required. Set (or leave unset) one variable:

```bash
export FHIR_BASE_URL=https://hapi.fhir.org/baseR4
```

Alternative open endpoints:
- `https://r4.smarthealthit.org` — SMART Health IT open R4 endpoint
- `https://bulk-data.smarthealthit.org/fhir` — Bulk data sandbox (100 synthetic patients)

### Mode 2 — SMART Backend Services (Epic, Oracle Cerner, or other vendor sandboxes)

Production vendor sandboxes (Epic Open, Cerner Code) require application registration and OAuth2 with a signed JWT assertion. Register your application at the vendor portal and set:

```bash
export FHIR_BASE_URL=https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4
export FHIR_CLIENT_ID=your-registered-client-id
export FHIR_PRIVATE_KEY_PEM="$(cat /path/to/private-key.pem)"
export FHIR_TOKEN_URL=https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token
export FHIR_SCOPE="system/Patient.rs system/Observation.rs system/Device.rs"
```

`FHIR_TOKEN_URL` is optional — if omitted, the harness discovers it automatically via `client.smartAuthMetadata()`.

**Where to get credentials:**
- Epic: [open.epic.com](https://open.epic.com) — register under "Build Apps"
- Oracle Cerner: [code.cerner.com](https://code.cerner.com) — register a new application
- Azure Health Data Services (FHIR): managed identity or app registration via Azure portal

**Never commit `FHIR_PRIVATE_KEY_PEM` or any credential to source control.** Use a secrets manager (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, GitHub Actions Secrets, or a `.env` file that is gitignored).

### Opt-in mutation gate

By default, all FHIR write operations are blocked by the MCP policy. To unlock them (for authorised integration testing only, never on production PHI endpoints):

```bash
export FHIR_ALLOW_WRITE=true
# AND pass --allow-write at scaffold time or re-run with:
npx @metaharness/example-fhir@latest my-fhir-bot --allow-write
```

Even with `FHIR_ALLOW_WRITE=true`, the MCP policy's `requireApprovalForDangerous: true` will surface an explicit approval prompt for each write operation.

---

## Usage

### Slash command

```
/fhir-query <natural language clinical or data query>
```

The `/fhir-query` command drives the full pipeline: `fhir-planner` decomposes the query into FHIR search parameters, `fhir-executor` retrieves and synthesises the data, and `fhir-verifier` confirms each cited resource via read-back before the result is presented.

### Representative prompts

```
/fhir-query "Show me all Observations with category=vital-signs for Patient/592"

/fhir-query "List all Device resources linked to Patient/592 and describe each device type"

/fhir-query "Fetch the last 10 laboratory Observations for Patient/592 and identify any values outside the reference range"

/fhir-query "Run a $everything operation for Patient/592 and summarise the key clinical findings"
```

### Direct agent invocation (Claude Code example)

```bash
claude -p --plugin-dir my-fhir-bot \
  "Search for all Observations with code=8867-4 (heart rate) across the last 90 days. Paginate through all results and summarise the trend. Verify each cited Observation by ID before reporting."
```

### Illustrative output

```
fhir-planner  → search plan: Observation?code=8867-4&date=ge2025-09-17&_count=20 [paginated]
fhir-executor → page 1: 20 Observations retrieved
fhir-executor → page 2: 7 Observations retrieved (last page)
fhir-executor → synthesis: heart rate trend shows mean 72 bpm, range 58-89 bpm, no critical values
fhir-verifier → re-reading Observation/obs-001 ... OK
fhir-verifier → re-reading Observation/obs-002 ... OK
fhir-verifier → 27/27 resources verified
result        → [clinical summary presented]
```

---

## Safety

**This scaffold is NOT a medical device and is NOT for clinical use.**

The full mandatory disclaimer:

> This example is for ILLUSTRATIVE and EDUCATIONAL purposes only. It is NOT a medical device, is NOT HIPAA-compliant, is NOT certified under any regulatory framework (FDA, CE, MDR, UKCA, or equivalent), and has NOT been validated for clinical use. Do NOT use it to make, inform, or assist in any clinical decision, diagnosis, treatment, or patient-care activity. The authors and contributors disclaim all liability for any use of this scaffold in a medical, clinical, or regulated context. Integrators are solely responsible for ensuring their production system meets all applicable regulatory, privacy, and security requirements.

Additional safety properties of this scaffold:

- **Read-only by default**: `fhir.create`, `fhir.update`, `fhir.patch`, `fhir.delete` are MCP-denied unless explicitly unlocked.
- **Sandbox by default**: the default endpoint contains only synthetic test data — no real patient health information (PHI).
- **No PHI in audit logs**: `.harness/mcp-audit.jsonl` records only resource type, resource ID, HTTP status, and timestamp — never resource content.
- **Secrets via ENV only**: no credential appears in any scaffolded file.
- **Verification gate**: `fhir-verifier` re-confirms every cited resource ID before output is presented, reducing hallucinated clinical data.

---

## How It Works

### Agent pipeline

```
User prompt
    |
    v
/fhir-query (slash command)
    |
    v
fhir-planner [Tier 2]
  - parses clinical query into FHIR search parameters
  - selects resource types (Patient, Observation, Device)
  - decides pagination strategy and whether $everything applies
    |
    v
fhir-executor [Tier 2 for fan-out, Tier 3 for synthesis]
  - calls client.search({ resourceType, searchParams })
  - paginates with client.nextPage({ bundle })
  - reads linked resources via client.read({ resourceType, id })
  - sends raw bundles to Tier 3 model for narrative synthesis
    |
    v
fhir-verifier [Tier 2]
  - re-reads each cited resource: client.read({ resourceType, id })
  - confirms resourceType, id, status, and key codes match
  - blocks output until all cited resources pass
    |
    v
Result presented to user
```

### Routing tiers

| Tier | Model | Task |
|---|---|---|
| 1 (WASM) | Agent Booster | Extracting a specific field from a known FHIR JSON shape (no LLM needed) |
| 2 (Haiku / cheap) | fhir-planner, fhir-executor fan-out, fhir-verifier | Query decomposition, pagination, search execution, read-back verification |
| 3 (Sonnet / Opus) | fhir-executor synthesis | Synthesising cross-resource clinical narratives, interpreting free-text notes, anomaly detection |

### MCP policy: granted tools

`.harness/mcp-policy.json` is default-deny and grants exactly these tools:

| Tool | Purpose |
|---|---|
| `fhir.read` | Fetch a single resource by type and ID |
| `fhir.search` | Query resources by search parameters |
| `fhir.nextPage` | Advance through paginated result bundles |
| `fhir.operation` | Execute FHIR operations such as `$everything` |
| `fhir.smartAuthMetadata` | Discover SMART authorization endpoints |
| `fhir.capabilityStatement` | Inspect server capabilities before querying |

All write-side tools are denied by default. All tool calls are appended to `.harness/mcp-audit.jsonl`.

---

## Links

- [fhir-kit-client on npm](https://www.npmjs.com/package/fhir-kit-client)
- [fhir-kit-client GitHub (Vermonster)](https://github.com/Vermonster/fhir-kit-client)
- [HAPI FHIR public R4 sandbox](https://hapi.fhir.org/baseR4)
- [SMART Health IT open R4 endpoint](https://r4.smarthealthit.org)
- [SMART Backend Services spec (HL7)](https://hl7.org/fhir/smart-app-launch/backend-services.html)
- [HL7 FHIR public test servers](https://confluence.hl7.org/display/FHIR/Public+Test+Servers)
- [ADR-063: example-fhir design record](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-063-example-fhir.md)
- [ADR-051: examples program](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md)
