# ADR-034: Open Intelligence Architecture (OIA) Integration

**Status**: Proposed
**Date**: 2026-06-14
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-004 (host integration model), ADR-010 (TDD test contracts), ADR-022 (MCP as gated primitive), ADR-030 (Discovery Loop propagation)
**Supersedes / Superseded-by**: none

---

## Context

### What is OIA?

The **Open Intelligence Architecture (OIA)** is a reference architecture published by the Agentics Foundation (founder: Reuven Cohen) at https://oia.agentics.org/. As of June 2026 it is at version **0.1** — an early-stage model actively soliciting community review via two published digests: a *Reader's Digest* (narrative overview) and a *Decision Log Digest* (design rationale). The source is available at https://github.com/agenticsorg/OIA-Model under an MIT license.

The model specifies a **nine-layer reference architecture for enterprise intelligent systems**, modelled on the same stratified approach as ISO/IEC 7498 (the OSI model). The nine layers span from physical compute at the bottom to the human-and-browser interface at the top, with six operational layers between them and two state-holding layers bracketing the operational core. Orthogonal to the layer stack, OIA defines **six horizontal cross-layer spans** — concerns that cannot be localised to any single layer (security, observability, governance, identity, policy enforcement, and interoperability are the expected candidates at this maturity level, though the v0.1 digest does not enumerate them by name in the public README).

OIA explicitly incorporates existing standards rather than replacing them. Its acknowledgements cite:

- **ISO/IEC 7498** (OSI) — structural precedent
- **NIST Cybersecurity Framework** and **NIST AI Risk Management Framework** — risk and governance posture
- **MITRE ATT&CK / ATLAS** — threat taxonomy
- **OWASP Top 10 for LLM Applications** — application-layer security
- **ISO/IEC 42001** — AI management system standard
- **Model Context Protocol (MCP)** — tool-access interoperability

OIA does **not** define a proprietary wire protocol, schema, or identity model. It is a *reference architecture*: a structured vocabulary and evaluation framework that vendors, architects, and regulators can use to assess alignment, identify capability gaps, and plan implementations. The adjacent ecosystem of wire-level specs (MCP for tool access, Google's A2A for agent-to-agent delegation, IBM/Hugging Face ACP for agent communication protocol, the Agent Protocol OpenAPI wrapper) sit *inside* OIA's framework as layer-specific implementations rather than competitors.

### Why OIA is relevant to MetaHarness

MetaHarness currently generates harnesses targeting six confirmed host adapters (Claude Code, Codex, pi.dev, Hermes, OpenClaw, RVM) with two more proposed (Copilot: ADR-032; GitHub Actions: ADR-033). Every one of those hosts is a silo: a harness generated for Claude Code is not discoverable or callable by a Codex client, and vice versa. A user who hands a harness to a colleague running a different platform must regenerate or manually adapt it.

OIA directly addresses this. Its nine-layer model provides a *common evaluation surface* across vendors and platforms. A harness that self-describes in OIA-aligned terms becomes:

1. **Discoverable** by any OIA-aware client or registry — not just the host it was generated for.
2. **Assessable** by architects and enterprise procurement using OIA as the evaluation rubric.
3. **Composable** in multi-vendor agent networks that use OIA as a coordination meta-framework.

The question this ADR must answer is: **where in the MetaHarness architecture does OIA plug in?**

### Three candidate integration points

Three distinct shapes were evaluated:

| Option | What it means |
|---|---|
| **(A) `@ruflo/host-oia`** | OIA becomes the 9th host adapter alongside Claude Code, Codex, etc. |
| **(B) Cross-cutting manifest layer** | Every generated harness emits an OIA capability manifest in addition to its host config — a harness built for Claude Code is *also* OIA-described. |
| **(C) Selectable primitive (parallel to MCP)** | `oia: 'on/off'` in the generator, like `mcp: 'off/local/remote'` in ADR-022. |

---

## Decision

### Shape: Cross-cutting manifest layer (Option B)

OIA is **not** a host adapter. A host adapter (ADR-004) is a runtime target — something the harness executes inside. OIA provides no runtime: there is no OIA CLI, no OIA server, no OIA execution environment at v0.1. Treating it as a 9th host (Option A) would be architecturally incorrect.

OIA is also not a protocol primitive in the same sense as MCP (Option C). MCP is a transport that changes what files get generated (`src/mcp/*`, `mcp-policy.json`) and which hosts can connect at runtime. OIA, being a *reference architecture*, generates a self-description — a manifest — not wiring. The selectable-primitive framing implies toggling runtime behaviour; OIA's v0.1 contribution is evaluative, not executional.

The correct shape is **Option B: a cross-cutting manifest layer**. Every generated harness, regardless of host selection, optionally emits an **OIA capability manifest** that expresses the harness's alignment to the OIA layer model. This manifest:

- Lives at `.harness/oia-manifest.json`.
- Is a structured self-description, not a runtime config file.
- Is inert data — it does not change how the harness runs.
- Is scannable, fingerprintable, and witness-bound (ADR-011), just like `mcp-policy.json`.
- Becomes discoverable by any OIA-aware registry or client that reads the harness's published package.

This keeps OIA as **additive infrastructure** that does not touch the kernel, does not change the host adapters, and does not require a runtime dependency on an OIA SDK (which does not yet exist at v0.1 maturity).

### OIA manifest schema (proposed, subject to OIA v1.0 revision)

```json
{
  "schema": 1,
  "oiaVersion": "0.1",
  "generatedAt": "<ISO 8601>",
  "harnessId": "<harness-name>@<version>",

  "layerAlignment": {
    "L1_physicalCompute":        "not-applicable",
    "L2_dataAndStorage":         "partial",
    "L3_models":                 "full",
    "L4_toolsAndIntegrations":   "full",
    "L5_agentOrchestration":     "full",
    "L6_workflowAndAutomation":  "partial",
    "L7_governanceAndPolicy":    "full",
    "L8_observabilityAndAudit":  "full",
    "L9_humanAndBrowserInterface":"partial"
  },

  "horizontalSpans": {
    "security":       { "status": "full",    "implementation": "mcp-policy.json + ADR-022" },
    "observability":  { "status": "partial", "implementation": "audit-log in src/mcp/audit.ts" },
    "identity":       { "status": "none",    "implementation": null },
    "governance":     { "status": "full",    "implementation": "mcp-policy.json + witness ADR-011" },
    "policyEnforcement": { "status": "full", "implementation": "policy.ts default-deny gate" },
    "interoperability":  { "status": "partial","implementation": "MCP (ADR-022); OIA manifest (this ADR)" }
  },

  "adjacentStandards": {
    "mcp":           { "mode": "local",  "policyPath": ".harness/mcp-policy.json" },
    "a2a":           { "mode": "none",   "note": "not yet wired" },
    "acp":           { "mode": "none",   "note": "not yet wired" },
    "agentProtocol": { "mode": "none",   "note": "not yet wired" }
  },

  "discoveryEndpoint": null,
  "registryUrl": null
}
```

Layer names and horizontal span keys are **placeholder names** derived from OIA v0.1's narrative description. They must be reconciled with OIA's authoritative layer nomenclature once v1.0 is published. The `oiaVersion` field carries a forward-compatibility signal: parsers that see `"0.1"` know they are reading a pre-stable manifest.

### Security composition: OIA identity and ADR-010 claims

OIA at v0.1 does not specify an identity or claims model. The v0.1 reader's digest does not enumerate a wire-level identity scheme. When OIA ships identity primitives (likely through OIDC-A, FIDO Agentic Authentication, or a bespoke credential envelope — none of those are confirmed), those primitives will need to compose with the MetaHarness claims-based authorization model (ADR-010) and the MCP default-deny gate (ADR-022).

**Pre-emptive rule:** if OIA introduces a capability scope that would widen an MCP permission (e.g. an OIA "trusted peer" claim that implicitly grants `allowNetwork: true`), the composition is **denied at the policy gate**. The `mcp-policy.json` default-deny posture is not negotiable for external identity claims. An OIA caller that wants elevated capability must request it through the same approval gate any other caller uses. This is analogous to how ADR-033 (GHA) treats `GITHUB_TOKEN` — the external token scopes the available capability, but the in-harness `mcp-policy.json` may be narrower, and the narrower constraint wins.

### What changes in the generator

The generator (ADR-003 composer) gains a new toggle:

```
oia: 'off' | 'manifest-only'
```

Default: `'off'` for the current iteration (deferred implementation). When set to `'manifest-only'`:

1. The generator emits `.harness/oia-manifest.json` with the self-assessed layer alignment filled in based on which primitives the harness was built with.
2. The harness's `package.json` gains a `"harness.oia"` key pointing at the manifest path.
3. `harness mcp-scan` is extended with an optional `--oia` flag that validates the manifest against the OIA schema (schema version check, required field presence, no unknown layer keys).
4. The witness manifest (ADR-011) fingerprints `.harness/oia-manifest.json` alongside `mcp-policy.json`.
5. The Discovery Loop (ADR-030) gains a 6th propagation surface: the OIA manifest is surfaced in the harness README table under a new "OIA Alignment" column.

No changes to:
- `@ruflo/kernel` (OIA is content, not kernel — ADR-002)
- Any existing host adapter
- `src/mcp/*`
- The existing `mcp-policy.json` default-deny gate
- The six existing host adapters

### Relationship to ADR-030 propagation

ADR-030 specifies that every new user-facing surface must traverse 5 propagation steps: build → README/skill → catalog → contextual discovery → test. The OIA manifest is a new user-facing surface. The propagation steps for this ADR are:

| Step | OIA action |
|---|---|
| 1. Build | `oia-manifest.json` emitted by generator |
| 2. Surface in README | "OIA Alignment" column in the host table |
| 3. Catalog | `harness.oia` key in `package.json`; entry in `dev-toolkit/plugin.json` |
| 4. Contextual discovery | `harness mcp-scan --oia` surfaces gaps; `harness diag` reports OIA mode |
| 5. Test | `__tests__/oia-manifest.test.ts` (see Test Contract below) |

---

## Consequences

### What gets better

- Every generated harness becomes self-describing in a vendor-neutral vocabulary. An enterprise evaluator using OIA as their procurement rubric can inspect the harness package without running it.
- The OIA manifest is inert data — no new runtime dependency, no SDK, no breaking change to any existing surface.
- The witness (ADR-011) covers the OIA manifest automatically once it is a file in the tree, giving the manifest provenance for free.
- When OIA ships a registry or discovery endpoint (not yet available at v0.1), harnesses can opt into discoverability with a one-line manifest update rather than a generator re-run.
- The `mcp-policy.json` default-deny composition rule is stated here pre-emptively. When OIA identity ships, the composition behaviour is already documented.

### What gets harder

- **Schema stability risk.** OIA v0.1 is explicitly pre-stable. The manifest schema proposed here (`layerAlignment`, `horizontalSpans`) is derived from narrative description, not a machine-readable schema. The names will likely change at OIA v1.0. The `oiaVersion` envelope field and the `schema: 1` envelope handle migration: parsers can switch on `oiaVersion` to handle shape changes without breaking.
- **Self-assessment is manual.** The layer alignment fields are self-reported by the generator based on which primitives the harness was built with. This is not verified by an external OIA compliance check (no such check exists at v0.1). A harness claiming `"L7_governanceAndPolicy": "full"` is stating a generator-computed assessment, not a certified result.
- **Two-step propagation.** The OIA manifest is emitted when `oia: 'manifest-only'` is set. The generator defaults to `off`. Users who want OIA coverage must know to opt in — this is the same pattern as `mcp: 'local'` but requires more explanation because OIA's value proposition is less immediately visible than MCP's.
- **No ADR-019 change yet.** Release orchestration (ADR-019) does not need to change for `manifest-only` mode — the manifest is a static JSON file. If OIA introduces a verification or publication step (e.g., submitting the manifest to an OIA registry on release), ADR-019 will need a follow-on amendment.

### What does not change

- The kernel is untouched.
- All host adapters are untouched.
- `mcp-policy.json` default-deny posture is unchanged and takes precedence over any OIA identity claim.
- All six existing host adapters remain unmodified.
- The test contract for existing subcommands (ADR-031 bundle pattern) is unchanged.

---

## Alternatives Considered

### Alternative A: Treat OIA as a 9th host adapter (`@ruflo/host-oia`)

OIA at v0.1 provides no runtime. There is no OIA CLI, no execution environment, no server binary. A host adapter (ADR-004) wraps a runtime; there is nothing to wrap. If OIA v1.0 ships a runtime agent environment (a plausible but unconfirmed direction), this ADR should be superseded by one that adds `@ruflo/host-oia`. For now, treating a reference architecture as an execution host is a category error.

### Alternative B: Treat OIA as a selectable primitive (`oia: 'on/off'` like MCP)

MCP is a transport primitive that changes which files get emitted, which hosts can connect, and which runtime behaviour is active. OIA at v0.1 does not change runtime behaviour — it describes alignment. Placing it in the same slot as MCP would imply runtime parity that does not exist, and would create confusion for implementors reading both ADR-022 and this one. The `manifest-only` mode is intentionally weaker than a full primitive to reflect OIA's actual maturity.

### Alternative C: Do nothing; MCP is sufficient for interoperability

MCP (ADR-022) solves tool-access interoperability within a session. It does not solve discovery, multi-vendor capability declaration, or enterprise procurement alignment. OIA addresses those gaps. "MCP is enough" is true for runtime tool invocation but false for the broader discoverability and evaluation problem OIA is designed for. Rejecting OIA entirely cedes the field to harnesses that do describe themselves in OIA terms, making MetaHarness-generated harnesses invisible to OIA-aware evaluators.

### Alternative D: Wait for OIA v1.0 before writing any ADR

The risk of waiting is that the schema design window closes: if the project ships a dozen harnesses before OIA stabilises, retroactively adding a manifest requires touching every generated harness. The `schema: 1` + `oiaVersion: "0.1"` envelope is precisely designed to tolerate forward incompatibility — the manifest can be emitted now with self-assessed v0.1 alignment and updated in-place when OIA v1.0 names the layers authoritatively. Deferring the ADR does not reduce schema risk; it defers the decision while locking in cost.

### Alternative E: Ship a minimal OIA shim only when an OIA-native client first asks for one

This is the same logic ADR-022 rejected for "MCP on demand": the safe path is to emit a governed, auditable surface by default (or at least on a known opt-in toggle) rather than scrambling to add compliance when a specific client demands it. The "demand-driven" approach produces ungoverned one-offs; the manifest approach produces a consistent, witness-bound artefact for every harness that opts in.

---

## Test Contract

The following tests must exist before this ADR's implementation is considered shipped. Tests are in vitest format matching the project's existing test patterns.

| # | File | Test description | What it pins |
|---|---|---|---|
| 1 | `__tests__/oia-manifest.test.ts` | `generateOiaManifest()` with `oia: 'manifest-only'` emits `.harness/oia-manifest.json` containing `schema`, `oiaVersion`, `generatedAt`, `harnessId`, `layerAlignment`, `horizontalSpans`, `adjacentStandards` | Manifest shape |
| 2 | `__tests__/oia-manifest.test.ts` | `generateOiaManifest()` with `oia: 'off'` emits nothing | Off-mode gate |
| 3 | `__tests__/oia-manifest.test.ts` | Manifest `oiaVersion` equals `"0.1"`; `schema` equals `1` | Envelope version |
| 4 | `__tests__/oia-manifest.test.ts` | Manifest is valid JSON parseable without error | JSON integrity |
| 5 | `__tests__/oia-manifest.test.ts` | A harness with `mcp: 'local'` sets `adjacentStandards.mcp.mode === 'local'`; a harness with `mcp: 'off'` sets it `'none'` | MCP reflection |
| 6 | `__tests__/oia-manifest.test.ts` | `horizontalSpans.policyEnforcement.status === 'full'` when `mcp-policy.json` default-deny is present | Policy reflection |
| 7 | `__tests__/harness-manifest.test.ts` (integration) | A generated harness with `oia: 'manifest-only'` stamps `primitives.oia === 'manifest-only'` into `.harness/manifest.json` | Manifest stamp |
| 8 | `__tests__/harness-manifest.test.ts` (integration) | The witness (ADR-011) fingerprints `oia-manifest.json` when present; the fingerprint changes when the manifest changes | Witness coverage |
| 9 | `__tests__/mcp-scan-oia.test.ts` | `harness mcp-scan --oia` returns exit 0 on a valid manifest; returns exit 1 with a structured error on a manifest missing the `oiaVersion` field | Scan gate |
| 10 | `__tests__/mcp-scan-oia.test.ts` | `harness mcp-scan --oia` does not run when `oia: 'off'`; does not affect existing MCP scan exit code | Scan isolation |
| 11 | `__tests__/oia-manifest.test.ts` | `layerAlignment` values are each one of `"full" | "partial" | "none" | "not-applicable"` | Enum constraint |
| 12 | `__tests__/oia-composition.test.ts` | A simulated OIA identity claim that would widen `allowNetwork` is rejected at the policy gate; `mcp-policy.json` default-deny takes precedence | Security composition rule |

---

## Open Questions (for the next iteration)

1. **Authoritative layer names.** OIA v0.1's README describes nine layers in narrative prose but does not enumerate machine-readable layer keys. The names used in the manifest schema above (`L1_physicalCompute`, …, `L9_humanAndBrowserInterface`) are inferred. The OIA project should be contacted for the canonical enumeration before any implementation lands.

2. **OIA registry.** The v0.1 spec has no discovery endpoint or public registry. When one ships, the `discoveryEndpoint` and `registryUrl` fields in the manifest (currently `null`) should be populated automatically from OIA's published endpoint. ADR-019 release orchestration may need an amendment to submit the manifest on publish.

3. **Identity composition.** OIA v0.1 does not define an identity model. The composition rule stated in this ADR (OIA identity claims cannot widen MCP policy) is pre-emptive. Before implementing any identity bridge, a follow-on ADR must specify how OIA credentials map to the claims-based authorization model (ADR-010) and what audit trail the composition produces.

4. **OIA v1.0 migration path.** The `oiaVersion` envelope defers breaking changes. But if OIA v1.0 changes the layer count (nine layers is a design decision, not a physical constant) or renames the horizontal spans, the generator's self-assessment logic must be updated. A follow-on ADR should supersede this one when OIA ships a stable schema.

---

## References

1. **OIA Model (official site, Reader's Digest v0.1)** — https://oia.agentics.org/ (accessed 2026-06-14)
2. **OIA Model GitHub repository (Agentics Foundation, MIT)** — https://github.com/agenticsorg/OIA-Model (accessed 2026-06-14)
3. **Agentics Foundation GitHub organization** — https://github.com/agenticsorg (accessed 2026-06-14)
4. **ISO/IEC 7498 (OSI Reference Model)** — cited in OIA v0.1 acknowledgements
5. **NIST Cybersecurity Framework** — cited in OIA v0.1 acknowledgements
6. **NIST AI Risk Management Framework** — cited in OIA v0.1 acknowledgements
7. **MITRE ATT&CK / ATLAS** — cited in OIA v0.1 acknowledgements
8. **OWASP Top 10 for LLM Applications** — cited in OIA v0.1 acknowledgements
9. **ISO/IEC 42001** — cited in OIA v0.1 acknowledgements
10. **Model Context Protocol (MCP)** — cited in OIA v0.1 acknowledgements; https://modelcontextprotocol.io
11. **Google Agent2Agent Protocol (A2A)** — https://github.com/a2aproject/A2A — adjacent standard, referenced in `adjacentStandards` block
12. **Agent Communication Protocol (ACP, IBM/Hugging Face)** — adjacent standard, referenced in `adjacentStandards` block
13. **OIDC-A (OpenID Connect for Agents)** — https://arxiv.org/pdf/2509.25974 — candidate identity primitive when OIA identity lands
14. **FIDO Agentic Authentication Technical Working Group** — https://fidoalliance.org/fido-alliance-to-develop-standards-for-trusted-ai-agent-interactions/ — candidate identity primitive
15. ADR-004 — Host integration model (why OIA is not a host adapter)
16. ADR-010 — TDD test contracts (test shapes this ADR follows)
17. ADR-011 — Witness + provenance (OIA manifest is witness-bound)
18. ADR-022 — MCP as gated primitive (default-deny rule that OIA identity cannot override)
19. ADR-030 — Discovery Loop (5-step propagation applied to the OIA manifest surface)
20. ADR-031 — Bundle JSON pattern (manifest schema follows `schema: 1` / `generatedAt` / `exitCode` envelope conventions)
21. ADR-032 — GitHub Copilot host (7th host — OIA is not the 8th host, it is the cross-cutting layer)
22. ADR-033 — GitHub Actions host (8th host — confirms OIA is not a 9th host)
