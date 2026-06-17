# @metaharness/example-datadog

**Incident triage from metrics, logs, and monitors — powered by the Datadog API and MetaHarness.**

> ⚠️ **Illustrative output.** This scaffold generates an AI-assisted triage bot for demonstration purposes. All findings are AI-generated and must be reviewed by a human before acting on them. This is not a production incident-management system.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-datadog?label=%40metaharness%2Fexample-datadog&color=purple)](https://www.npmjs.com/package/@metaharness/example-datadog)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-datadog)](https://www.npmjs.com/package/@metaharness/example-datadog)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![Built with MetaHarness](https://img.shields.io/badge/built--with-MetaHarness-blue)](https://github.com/ruvnet/agent-harness-generator)

---

## What this is

`@metaharness/example-datadog` scaffolds a ready-to-run AI agent bot that performs **read-only incident triage** against your Datadog organisation. It demonstrates how to wire the official `@datadog/datadog-api-client` SDK into a MetaHarness multi-agent workflow with tiered model routing, an MCP default-deny policy, and a verification gate that re-queries before finalising any finding.

### This package IS:
- A MetaHarness SDK showcase for the Datadog API
- A working npx-runnable scaffold you can use as a starting point
- Read-only by default — no monitor mutations, no incident creation
- Compatible with all nine MetaHarness hosts via `--host`

### This package IS NOT:
- A production incident-management platform
- A replacement for PagerDuty, Opsgenie, or Datadog's own incident workflows
- Able to act on alerts without explicit `--allow-mutations` opt-in

---

## Features

- **`/dd-triage` slash command** — describe a firing alert in plain English; the bot correlates metrics, logs, and monitors and returns a root-cause hypothesis
- **Three-agent pipeline**: `dd-collector` (Haiku, fast fan-out) → `dd-analyst` (Sonnet/Opus, root-cause reasoning) → `dd-verifier` (Sonnet/Opus, re-query gate)
- **Tiered model routing** (ADR-026): Haiku for parallel read fan-out, Sonnet/Opus for reasoning — balances cost and quality
- **MCP default-deny** (ADR-022): grants only seven named read tools; all mutation tools absent and therefore denied
- **Verification gate** (ADR-050): `dd-verifier` re-queries the primary metric and referenced monitor before surfacing results; contradictions trigger a re-analysis loop
- **Nine-host scaffold**: `--host all` wires claude-code, codex, copilot, github-actions, hermes, openclaw, opencode, pi-dev, and rvm
- **Mutation opt-in**: pass `--allow-mutations` to unlock monitor mute, incident creation, and event posting — off by default
- **`npm run doctor`**: validates `DD_API_KEY`, `DD_APP_KEY`, and `DD_SITE` reachability before any agent runs

---

## Quickstart

```bash
# Scaffold a new project (claude-code host, read-only default)
npx @metaharness/example-datadog@latest my-dd-bot

# Move into the project and install dependencies
cd my-dd-bot && npm install

# Verify your Datadog credentials and site are reachable
npm run doctor
```

Then open `.env` (copied from `.env.example`), fill in your keys, and start triaging:

```bash
# Run the /dd-triage slash command
npx metaharness run /dd-triage "High error rate on payments-service in production for the last 30 minutes"
```

---

## Configuration

Set the following environment variables in your `.env` file (never commit this file):

| Variable | Required | Description |
|---|---|---|
| `DD_API_KEY` | Yes | Datadog API key. Obtain from [Organisation Settings → API Keys](https://app.datadoghq.com/organization-settings/api-keys). |
| `DD_APP_KEY` | Yes | Datadog Application key. Required for all read operations. Obtain from [Organisation Settings → Application Keys](https://app.datadoghq.com/organization-settings/application-keys). |
| `DD_SITE` | No | Datadog site region. Defaults to `datadoghq.com` (US1). EU: `datadoghq.eu`. AP1: `ap1.datadoghq.com`. US3: `us3.datadoghq.com`. Gov: `ddog-gov.com`. |

The `@datadog/datadog-api-client` SDK picks up all three values automatically from the process environment.

### Scaffold on a different host

```bash
npx @metaharness/example-datadog@latest my-dd-bot --host github-actions   # one host
npx @metaharness/example-datadog@latest my-dd-bot --host all              # all nine hosts
```

---

## Usage

### `/dd-triage` — core slash command

```
/dd-triage <alert description> [--service <name>] [--env <env>] [--from <ISO8601>] [--to <ISO8601>]
```

**Sample prompt:**

```
/dd-triage "p99 latency on checkout-service exceeded 2 s SLO for 15 minutes" \
  --service checkout-service \
  --env production \
  --from 2026-06-17T08:00:00Z \
  --to 2026-06-17T08:30:00Z
```

**Sample output (illustrative):**

```
dd-collector  [Haiku]   Queried 3 timeseries, 1 log search (847 events), 4 monitors.
dd-analyst    [Sonnet]  Hypothesis: upstream database connection pool exhaustion.
                        Evidence: db.pool.wait_time up 8x at 08:04 UTC correlates
                        with latency spike. 2 monitors in ALERT state.
dd-verifier   [Sonnet]  Re-queried db.pool.wait_time at 08:29 UTC — still elevated.
                        Hypothesis CONFIRMED. Confidence: high.

Root cause (illustrative): Database connection pool exhausted on checkout-db-primary.
Recommended next step: review connection pool settings and recent deploy history.
```

---

## Safety

- **Read-only by default.** The generated `.harness/mcp-policy.json` grants only: `metrics.queryTimeseries`, `logs.listLogs`, `monitors.listMonitors`, `monitors.getMonitor`, `incidents.listIncidents`, `incidents.getIncident`, `auditLogs.listAuditLogs`. All other Datadog tools are denied.
- **No secrets in source.** `DD_API_KEY` and `DD_APP_KEY` are read from environment variables only. The scaffold adds `.env` to `.gitignore` automatically.
- **Mutation opt-in.** To enable monitor muting, incident creation, or event posting, pass `--allow-mutations` at scaffold time. This appends a clearly labeled mutation grant block to the MCP policy and emits a warning.
- **Verification gate.** `dd-verifier` re-queries before finalising any finding. A mismatch triggers up to two re-analysis iterations before output is surfaced.
- **Output is illustrative.** All AI-generated findings must be reviewed by a human engineer before any production action is taken.

---

## How it works

### Agent pipeline

```
User prompt
    │
    ▼
/dd-triage slash command
    │
    ▼
dd-collector  [Haiku — Tier 1]
  ├─ v2.MetricsApi.queryTimeseries()     ← parallel
  ├─ v2.LogsApi.listLogs()               ← parallel
  ├─ v1.MonitorsApi.listMonitors()       ← parallel
  └─ v2.IncidentsApi.listIncidents()     ← parallel
    │
    ▼  structured evidence payload
dd-analyst    [Sonnet/Opus — Tier 2]
  └─ root-cause hypothesis + confidence scores
    │
    ▼
dd-verifier   [Sonnet/Opus — Tier 2]  ← verification gate (ADR-050)
  ├─ re-query primary metric
  ├─ re-read referenced monitor
  └─ CONFIRM / CONTRADICT → re-invoke analyst if contradicted (max 2 loops)
    │
    ▼
Final structured output → user
```

### Tiered routing (ADR-026)

| Tier | Model | Agent | Reason |
|---|---|---|---|
| 1 | Haiku | dd-collector | Parallel REST fan-out: cheap, fast, low reasoning load |
| 2 | Sonnet / Opus | dd-analyst, dd-verifier | Root-cause synthesis and contradiction detection |

### MCP granted tools

`metrics.queryTimeseries` · `logs.listLogs` · `monitors.listMonitors` · `monitors.getMonitor` · `incidents.listIncidents` · `incidents.getIncident` · `auditLogs.listAuditLogs`

All other Datadog MCP tools: **denied** (default-deny per ADR-022).

---

## Links

- [Datadog API Reference](https://docs.datadoghq.com/api/latest/)
- [Datadog TypeScript client — GitHub](https://github.com/DataDog/datadog-api-client-typescript)
- [Datadog TypeScript client — npm](https://www.npmjs.com/package/@datadog/datadog-api-client)
- [Datadog Authentication docs](https://docs.datadoghq.com/api/latest/authentication/)
- [ADR-059: example-datadog](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-059-example-datadog.md)
- [MetaHarness — agent-harness-generator](https://github.com/ruvnet/agent-harness-generator)
