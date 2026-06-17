# ADR-063: example-fhir — Health / Medical Devices (FHIR) SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Electronic Health Records (EHR) are among the most consequential data sources an AI agent could interact with. FHIR (Fast Healthcare Interoperability Resources) R4 has become the US federal mandate (21st Century Cures Act) and the de-facto international interchange standard for patient data, lab results, medical device telemetry, medications, and clinical observations. For an agent harness to be useful in health-tech contexts — clinical analytics platforms, IoT medical devices, patient-facing apps, population-health pipelines — it must be able to read, interpret, and act on FHIR resources in a safe, auditable, and regulation-aware way.

The agent-harness-generator user base includes health-tech startups building SMART on FHIR apps, hospital IT teams integrating wearables and implantable telemetry, and researchers who need to fan out queries across Patient/Observation/Device cohorts. Today a user generating a harness for these workflows starts from scratch. This example eliminates that first weekend of wiring.

`fhir-kit-client` (npm: `fhir-kit-client`, maintained by Vermonster) is the most widely referenced Node.js FHIR R4 client. It is framework-agnostic, ESM-native as of v2.0.2 (May 2026), requires Node 18+, ships TypeScript types, supports both open and authenticated (Bearer token / SMART Backend Services) endpoints, and covers every FHIR REST operation the example needs: `read`, `search`, `operation`, `nextPage`, and `smartAuthMetadata`. It is the natural choice for a showcase targeting health/medical device data.

The regulated nature of health data makes this example illustrative-only. HIPAA compliance, HITRUST certification, SOC 2 attestation, and FDA software-as-a-medical-device (SaMD) classification are the responsibility of the production system integrator, not this scaffold. The example ships with a prominent, mandatory not-for-production disclaimer.

---

## Decision

### Chosen SDK

`fhir-kit-client` v2.x (ESM-only, Node 18+, Vermonster). Imported as:

```js
import Client from 'fhir-kit-client';
```

Constructor:

```js
const client = new Client({
  baseUrl: process.env.FHIR_BASE_URL,   // required
  bearerToken: token,                    // set after SMART auth exchange
  customHeaders: { 'Accept': 'application/fhir+json' },
});
```

### Headline Capability

Read a patient cohort from a PUBLIC SANDBOX EHR, fan out to fetch linked Observation (lab results, vital signs) and Device (implanted and wearable device records) resources, summarise clinical context with a frontier model, and confirm every result against the sandbox via read-back before presenting as done. No mutations are performed by default; the sandbox is treated as a read-only data source.

The default sandbox is the HAPI FHIR public R4 server at `https://hapi.fhir.org/baseR4` — no registration, no credentials, HTTP REST, open to all. Developers may also point at `https://r4.smarthealthit.org` (SMART Health IT open endpoint) or `https://bulk-data.smarthealthit.org/fhir` (bulk-data sandbox, 100 synthetic patients, no auth). Production endpoints (Epic, Oracle Cerner) use SMART Backend Services OAuth2 with JWT assertion; all required env vars are documented and loaded exclusively from the environment.

### Agent and Skill Design

Three agents ship in the scaffold:

**1. `fhir-planner` (Tier 2 — cheap model)**
Receives a natural-language clinical query (e.g. "summarise all Observations for Patient 123 from the last 30 days"). Decomposes it into a FHIR search plan: which resource types to query, which search parameters (`patient`, `date`, `category`, `code`, `_count`), pagination strategy, and whether a `$everything` operation applies. Emits a structured search plan consumed by the executor.

**2. `fhir-executor` (Tier 2 — cheap model for fan-out; Tier 3 for synthesis)**
Executes the search plan against the FHIR endpoint using `fhir-kit-client`. Handles pagination via `client.nextPage({ bundle })`. For each patient, fans out in parallel to fetch linked Observation and Device resources. Passes raw bundles to the frontier model for clinical-context summarisation. Uses Tier 2 for raw resource retrieval and pagination; escalates to Tier 3 (Sonnet/Opus) for synthesising cross-resource clinical narratives.

**3. `fhir-verifier` (Tier 2 — cheap model)**
Re-reads each cited resource by ID via `client.read({ resourceType, id })` and confirms the response matches what the executor reported (resourceType, id, status, key codes). Flags any discrepancy as an unresolved inconsistency. The harness does not present output as done until this gate passes. Implements the ADR-050 verification-gated output pattern.

**Slash command**: `/fhir-query`
Drives the full planner → executor → verifier pipeline from a single prompt. Example:

```
/fhir-query "Fetch all Observations with category=vital-signs for Patient/87a339d0-8cae-11ee-b9d1-0242ac120002 and summarise trends"
```

### Routing Tiers

| Model tier | Handler | When used |
|---|---|---|
| Tier 1 (Agent Booster / WASM) | Skip LLM | Simple JSON field extraction from a known FHIR resource structure |
| Tier 2 (Haiku / cheap) | `fhir-planner`, `fhir-executor` fan-out, `fhir-verifier` | Search plan decomposition, pagination, read-back verification |
| Tier 3 (Sonnet / Opus) | `fhir-executor` synthesis step | Cross-resource clinical narrative, anomaly detection, free-text interpretation |

### MCP Policy

`.harness/mcp-policy.json` ships with default-deny and grants exactly the tools this platform needs:

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
    "fhir.read",
    "fhir.search",
    "fhir.nextPage",
    "fhir.operation",
    "fhir.smartAuthMetadata",
    "fhir.capabilityStatement"
  ],
  "deniedTools": [
    "fhir.create",
    "fhir.update",
    "fhir.patch",
    "fhir.delete",
    "fhir.batch",
    "fhir.transaction"
  ]
}
```

Write and mutate tools (`fhir.create`, `fhir.update`, `fhir.patch`, `fhir.delete`, `fhir.batch`, `fhir.transaction`) are explicitly denied unless the opt-in flag `FHIR_ALLOW_WRITE=true` is set AND the user passes `--allow-write` at scaffold time. Even then, `requireApprovalForDangerous: true` surfaces an approval prompt for each mutation.

Network is granted (`allowNetwork: true`) because all FHIR operations are HTTP calls. Shell and file-write remain denied. All tool calls are appended to `.harness/mcp-audit.jsonl`.

### Auth Model

**Mode 1 — Open sandbox (default, no credentials required)**
Point `FHIR_BASE_URL` at `https://hapi.fhir.org/baseR4` or `https://r4.smarthealthit.org`. No token, no registration. Suitable for initial exploration and CI smoke tests.

**Mode 2 — SMART Backend Services (production sandboxes: Epic, Cerner)**
Set `FHIR_BASE_URL`, `FHIR_CLIENT_ID`, `FHIR_PRIVATE_KEY_PEM` (PEM-encoded RS384 or ES384 private key), `FHIR_TOKEN_URL` (discovered via `client.smartAuthMetadata()` if omitted), and `FHIR_SCOPE` (default: `system/Patient.rs system/Observation.rs system/Device.rs`). The harness exchanges a signed JWT assertion (`client_credentials` grant, `urn:ietf:params:oauth:client-assertion-type:jwt-bearer`) for an access token, sets `client.bearerToken = token`, and re-acquires before expiry. No secret ever appears in scaffolded files.

Env vars:

| Variable | Required | Description |
|---|---|---|
| `FHIR_BASE_URL` | Yes | FHIR R4 base URL (default: `https://hapi.fhir.org/baseR4`) |
| `FHIR_CLIENT_ID` | Mode 2 only | Registered client ID from your EHR vendor portal |
| `FHIR_PRIVATE_KEY_PEM` | Mode 2 only | PEM-encoded private key (RS384 or ES384); never commit |
| `FHIR_TOKEN_URL` | Mode 2 optional | Token endpoint; auto-discovered via `.well-known/smart-configuration` if absent |
| `FHIR_SCOPE` | No | OAuth2 scopes (default: `system/Patient.rs system/Observation.rs system/Device.rs`) |
| `FHIR_ALLOW_WRITE` | No | Set `true` to unlock create/update/delete (opt-in mutation gate) |

### Safety Gates

- **Read-only by default**: `fhir.create`, `fhir.update`, `fhir.patch`, `fhir.delete`, `fhir.batch`, `fhir.transaction` are MCP-denied unless `FHIR_ALLOW_WRITE=true` is explicitly set. This default protects both the open sandbox (which accepts unauthenticated writes) and any production endpoint the user accidentally misconfigures.
- **Sandbox by default**: the default `FHIR_BASE_URL` is the open HAPI test server. No PHI is ever present on this server; all data is synthetic.
- **No PHI in logs**: the audit log records only resource type, resource ID, and HTTP status — never resource content.
- **Not a medical device**: see Consequences section for the mandatory disclaimer.
- **Secrets via ENV only**: no credential appears in any scaffolded file. The README links to each vendor's key-issuance page.

---

## Consequences

### Positive

- Gives health-tech developers a one-command starting point for FHIR R4 agent harnesses across all 9 supported hosts (claude-code, codex, copilot, github-actions, hermes, openclaw, opencode, pi-dev, rvm).
- Demonstrates MCP default-deny with an explicit mutation blocklist — the most conservative posture in the example series, appropriate for the regulated domain.
- The HAPI public sandbox requires zero registration, making the Quickstart verifiable in under two minutes.
- The `/fhir-query` slash command is a reusable pattern for clinical analytics, population-health queries, and device-telemetry dashboards.
- The three-agent (planner/executor/verifier) design + verification gate follows ADR-050 and is directly applicable to production clinical-decision-support workflows.

### Honest Limitations

- `fhir-kit-client` v2.x is ESM-only and requires Node 18+. CommonJS environments or older Node runtimes need a separate CJS-compatible FHIR client (e.g. the older v1.9.2 or `fhirclient`).
- The public HAPI server (`hapi.fhir.org/baseR4`) is a shared test instance. It is occasionally slow, has no SLA, and may contain inconsistent data uploaded by other developers. It is not suitable as a performance benchmark.
- SMART Backend Services auth (Mode 2) requires out-of-band application registration with each EHR vendor (Epic App Orchard, Oracle Cerner Code Console, etc.). This is a multi-day process and outside the scope of this scaffold.
- The example does not implement SMART EHR Launch (the OAuth2 redirect-based user-context flow used by patient-facing apps). It covers only the backend-services (system-level) auth path.
- Bulk FHIR (`$export`) is not scaffolded in this version; the `$everything` operation and paginated `search` cover most analytical use cases within the sandbox scale.

### Not-for-Production Disclaimer (mandatory — regulated domain)

> **This example is for ILLUSTRATIVE and EDUCATIONAL purposes only. It is NOT a medical device, is NOT HIPAA-compliant, is NOT certified under any regulatory framework (FDA, CE, MDR, UKCA, or equivalent), and has NOT been validated for clinical use. Do NOT use it to make, inform, or assist in any clinical decision, diagnosis, treatment, or patient-care activity. The authors and contributors disclaim all liability for any use of this scaffold in a medical, clinical, or regulated context. Integrators are solely responsible for ensuring their production system meets all applicable regulatory, privacy, and security requirements.**
