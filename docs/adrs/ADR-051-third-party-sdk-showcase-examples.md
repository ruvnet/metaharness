# ADR-051: Third-party SDK showcase examples (`npx @metaharness/example-*`)

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-001 (Goals/Non-Goals), ADR-015 (Naming + branding), ADR-022 (MCP default-deny gate), ADR-044/045/046 (host coverage + real-install verification), ADR-050 (harness intelligence — verification-gated output)
**Series**: ADR-052…ADR-069 (one per platform — see catalog below)

---

## Context

`metaharness` scaffolds an agent harness from any repo, and the existing
`examples-packages/*` show **host** integrations (Claude Code, Codex, …) and
**vertical** pods (research, trading, …). What they do *not* show is the other
half of the value proposition: an agent harness is only useful when it can
**act on real third-party systems** — cloud, payments, comms, data, ML, health,
and the long tail of trending/exotic platforms.

Prospective users ask a concrete question: *"If I generate a harness, can it
actually drive Stripe / AWS / a FHIR server / Hugging Face, safely, across the
host I already use?"* Today the answer is "yes, but you wire it yourself." That
is exactly the weekend of work `metaharness` exists to delete.

This ADR defines a **series of example packages** — one per third-party
platform — each runnable as `npx @metaharness/example-<slug> <name>`, that
scaffolds a harness pre-wired to that platform's SDK, on **all supported hosts**,
showcasing both metaharness capabilities (tiered routing, MCP default-deny,
skills/commands, verification gates, swarm coordination) and the third party's
capabilities. Each example is documented by its own ADR (the "why this design"
record) and ships a README a newcomer can follow.

## Decision

Ship a curated catalog of `@metaharness/example-<slug>` packages, each governed
by a per-platform ADR, all conforming to the shared contract below.

### 1. Naming & invocation

- npm package: **`@metaharness/example-<slug>`** (scoped, public).
- Directory: `examples-packages/example-<slug>/`.
- Invocation: `npx @metaharness/example-<slug>@latest <project-name>`.
- `bin` MUST be `"bin/scaffold.mjs"` **with no `./` prefix** (npm strips a
  `./`-prefixed bin on publish — see GH #13; the showcase packages must not
  reproduce that bug).

### 2. Every example scaffolds across ALL hosts

A `--host <id>` flag (default `claude-code`) selects the host adapter; `--host all`
emits every host's config. Supported hosts (ADR-044/045/046): `claude-code`,
`codex`, `copilot`, `github-actions`, `hermes`, `openclaw`, `opencode`,
`pi-dev`, `rvm`. The scaffold delegates to the `metaharness` CLI + the relevant
`@metaharness/host-<id>` adapter so host wiring stays single-sourced.

### 3. Capability showcase matrix (what each example must demonstrate)

| metaharness capability | How the example shows it |
|---|---|
| **Tiered model routing** (ADR-026) | cheap tier for fan-out/extraction, frontier tier for reasoning/decisions |
| **MCP default-deny** (ADR-022) | a scoped `.harness/mcp-policy.json` granting only the platform's needed tools + audit log |
| **Skills / slash commands** | at least one `/<verb>` command driving the platform's headline capability |
| **Agents/pods** | ≥2 specialized agents (e.g. planner + executor + verifier) |
| **Verification gate** (ADR-050) | a `verify` step that re-checks agent output against the platform (dry-run / read-back) before it is presented as done |
| **Swarm coordination** (where apt) | parallel fan-out with claim-TTL for batch platform operations |

### 4. Safety posture (non-negotiable, per platform)

- **Secrets via environment only** — never written to scaffolded files; READMEs
  document the exact env vars and link to the platform's key-issuance page.
- **Read-only / dry-run / sandbox by default** — any mutating capability
  (charges, deploys, sends, writes, orders, prescriptions, trades) ships gated
  behind an explicit, documented opt-in flag and defaults to the platform's test
  mode (Stripe test keys, AWS dry-run, paper trading, FHIR sandbox, etc.).
- **Health/medical & financial examples are illustrative, not certified** — the
  README carries a prominent disclaimer (not a medical device, not financial
  advice, not HIPAA/PCI-compliant out of the box).
- MCP surface is **default-deny**; the example grants only the minimum tools.

### 5. README contract (every example)

Markdown with, in order: title + one-line tagline; an **illustrative-output**
disclaimer; **badges** (npm version, npm downloads, license, node engine, "built
with metaharness"); **Intro** (what it is / is not); **Features** (the capability
matrix above, concretely); **Quickstart** (`npx … && cd … && npm install && npm
run doctor`); **Configuration** (env vars / auth); **Usage** (the slash commands
+ a representative prompt); **Safety**; **How it works** (agents + routing +
MCP policy); **Links** (SDK docs, ADR). Badges use shields.io.

### 6. Per-platform ADR contract

Each ADR-052+ records, for one platform: the chosen SDK/package + why; the
headline capability the example showcases; the agent/skill design; the routing
tiers; the MCP policy (granted tools); the safety gates; auth model; and the
honest limitations. Same header format as this file.

### 7. The catalog (practical → exotic)

| ADR | Package | Platform | SDK | Headline showcase |
|---|---|---|---|---|
| 052 | example-aws | Amazon Web Services | `@aws-sdk/*` v3 | provision/query infra with dry-run-by-default |
| 053 | example-gcp | Google Cloud | `@google-cloud/*` | storage + BigQuery + Vertex, ADC auth |
| 054 | example-azure | Microsoft Azure | `@azure/*` | resource mgmt + Blob + OpenAI-on-Azure |
| 055 | example-stripe | Stripe | `stripe` | billing ops in **test mode** by default |
| 056 | example-slack | Slack | `@slack/web-api`, Bolt | triage/notify with scoped tokens |
| 057 | example-github | GitHub | `@octokit/*` | PR/issue automation (the dogfood case) |
| 058 | example-twilio | Twilio | `twilio` | SMS/voice with magic-number sandbox |
| 059 | example-datadog | Datadog | `@datadog/datadog-api-client` | incident triage from metrics/logs |
| 060 | example-supabase | Supabase | `@supabase/supabase-js` | RLS-aware data agent |
| 061 | example-huggingface | Hugging Face | `@huggingface/inference`, hub | model/dataset discovery + inference |
| 062 | example-pinecone | Pinecone | `@pinecone-database/pinecone` | RAG memory over a vector index |
| 063 | example-fhir | Health / medical devices | `fhir-kit-client` (SMART on FHIR) | read patient/device data from a **sandbox** EHR |
| 064 | example-ads | Ad platforms | Google Ads + Meta Marketing API | campaign analysis, read-only by default |
| 065 | example-web3 | Blockchain / web3 | `viem` / `ethers` | read-chain + simulate tx (testnet) |
| 066 | example-iot | IoT / robotics | MQTT (`mqtt`) + ROS 2 bridge | device telemetry + guarded actuation |
| 067 | example-nasa | Space / satellites | NASA Open APIs + TLE (`satellite.js`) | imagery + orbital pass prediction |
| 068 | example-qiskit | Quantum computing | IBM Qiskit Runtime (+ ruvnet `ruqu`) | build/simulate circuits, verify before hardware |
| 069 | example-bio | Bioinformatics | NCBI E-utilities / Ensembl REST | sequence + literature retrieval |

The list spans **practical** (cloud, payments, comms, dev) → **data/ML**
(HF, vector, Supabase) → **regulated** (health, ads) → **exotic** (web3, IoT,
space, quantum, bio). Additional platforms append as ADR-070+.

## Consequences

- **Positive**: turns "can a generated harness really *do* things?" into 18
  one-command proofs across every host; each is a copy-paste starting point;
  the catalog doubles as living integration tests for the host adapters and the
  capability primitives; showcases third-party + metaharness value together.
- **Cost/risk**: 18 packages to maintain + keep SDK-current; mitigated by the
  shared scaffold contract (host wiring is single-sourced through the
  `metaharness` CLI) and by dry-run/sandbox defaults that keep examples safe to
  run. Regulated-domain examples (health, ads, payments) carry explicit
  not-for-production disclaimers.
- **Provenance**: per-platform designs are researched against each SDK's current
  docs (deep-researcher agents) and recorded in ADR-052+ so the "why" survives.
