---
name: oia-manifest
description: Emit .harness/oia-manifest.json declaring layer alignment with the OIA v0.1 9-layer reference architecture. Self-describes the harness's MCP wiring, witness signing, audit log, identity posture (always 'none' at v0.1). --check verifies an existing manifest, --dry-run prints without writing, --json emits to stdout.
---

# oia-manifest

> Codex skill: emit/validate the OIA cross-cutting manifest layer
> (ADR-034, iter 121 → iter 122).

## What it does

Emits `.harness/oia-manifest.json` — the harness's self-assessment against
the **Open Intelligence Architecture (OIA) v0.1** 9-layer reference model
published by the Agentics Foundation at <https://oia.agentics.org>.

The manifest declares:

- **9 layer alignments** — L1 physicalCompute → L9 humanAndBrowserInterface,
  each `full` / `partial` / `none` / `not-applicable`
- **6 horizontal spans** — security · observability · identity · governance ·
  policyEnforcement · interoperability, each `full` / `partial` / `none`
  with an `implementation` reference (file path or ADR number)
- **4 adjacent standards** — `mcp`, `a2a`, `acp`, `agentProtocol` with
  current mode + wiring notes
- **`discoveryEndpoint` + `registryUrl`** (both `null` at v0.1; OIA has no
  registry yet)

## Why a manifest, not a host adapter?

OIA at v0.1 has no runtime and no wire protocol — it's a vendor-neutral
vocabulary for assessing system alignment. The right plug-in shape is a
**static cross-cutting manifest** (ADR-034 Decision: Option B). It plugs in
ABOVE the host adapter contract and BELOW the MCP policy gate.

## Usage from Codex

```
/oia-manifest path=./my-harness
/oia-manifest path=./my-harness check=true
/oia-manifest path=./my-harness dry-run=true
```

## Equivalent CLI

```bash
harness oia-manifest ./my-harness                # write .harness/oia-manifest.json
harness oia-manifest ./my-harness --check        # validate existing manifest
harness oia-manifest ./my-harness --dry-run      # stdout, no file write
harness oia-manifest ./my-harness --json         # stdout JSON
```

## Verdict + exit codes (--check)

| Verdict | Exit | Meaning |
|---|---|---|
| `PASS` | 0 | manifest shape ok, oiaVersion echoed |
| `DRIFT` | 1 | shape mismatch — per-field reasons surfaced |
| `FAIL no manifest` | 2 | `.harness/oia-manifest.json` missing |

## Sample manifest (excerpt)

```json
{
  "schema": 1,
  "oiaVersion": "0.1",
  "harnessId": "my-bot@0.1.0",
  "layerAlignment": {
    "L4_toolsAndIntegrations": "full",
    "L7_governanceAndPolicy": "full"
  },
  "horizontalSpans": {
    "identity": { "status": "none", "implementation": null },
    "security": { "status": "full", "implementation": "mcp-policy.json + ADR-022" }
  },
  "adjacentStandards": {
    "mcp": { "mode": "local", "policyPath": ".harness/mcp-policy.json" }
  },
  "discoveryEndpoint": null,
  "registryUrl": null
}
```

## Pre-emptive composition rule (ADR-034 §120)

If a future OIA identity primitive ever wants to widen an MCP permission,
the composition is **denied at the policy gate**. The `mcp-policy.json`
default-deny posture is not negotiable for external identity claims.

## Related skills

- `validate-harness` (iter 22) — release-readiness umbrella
- `threat-model` (iter 114) — MCP threat-model for PR/compliance review
- `diag-harness` (iter 70) — kernel-version skew check

## See also

- [ADR-034 — OIA Integration](../../../docs/adrs/ADR-034-oia-integration.md)
- [ADR-022 — MCP primitive](../../../docs/adrs/ADR-022-mcp-primitive.md)
- [ADR-030 — Discovery Loop](../../../docs/adrs/ADR-030-discovery-loop.md)
- [oia.agentics.org](https://oia.agentics.org)
