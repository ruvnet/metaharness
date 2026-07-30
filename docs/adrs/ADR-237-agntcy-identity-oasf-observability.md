# ADR-237: AGNTCY identity, OASF export, and semantic observability for generated harnesses

**Status**: Proposed
**Date**: 2026-07-30
**Project**: `ruvnet/agent-harness-generator`
**Deciders**: ruv
**Tags**: agntcy, outshift, oasf, identity, observability, federation, internet-of-cognition
**Extends**: ADR-002 (Kernel boundary), ADR-011 (Witness manifest + provenance), ADR-159 (HarnessSpec declarative policy), ADR-005 (Marketplace three-layer provenance)
**Companion**: ruflo ADR-324 (AGNTCY/Outshift runtime integration — SLIM transport, CASA enforcement, IOC Layer 9 coordination events). This ADR covers what MetaHarness produces at build/manifest time; ADR-324 covers what RuFlo does with it at runtime. Neither is complete without the other; they are numbered and shipped as a pair.
**Prompted by**: a strategic brief evaluating Cisco Outshift's AGNTCY / Internet of Cognition ecosystem (Mycelium is one coordination implementation inside that broader IoC program) as complementary, not competitive, infrastructure:

> AGNTCY and Outshift define the agent network. MetaHarness builds and evolves the agents. RuFlo executes and coordinates them. Meta LLM governs inference, cost, tenancy, and safety. RuVector supplies local memory and semantic state.

---

## 1. Context

A repo-wide check found **zero existing references** to AGNTCY, Outshift, OASF, CASA, SLIM, or Mycelium anywhere in this codebase or in ruflo's — this is genuinely greenfield integration, not a gap in an existing effort.

What already exists that this ADR must not duplicate:

- **Witness manifest + provenance (ADR-011)**: every generated harness already ships a signed `witness.json` attesting behavioral state (fixes, memory namespace checksums, manifest SHA) plus an `npm publish --provenance` Sigstore attestation. This is *internal* build-provenance trust.
- **HarnessSpec (ADR-159)**: the declarative, mutatable policy graph (`roles, steps, branches, tools, budgets, guards, memory, evaluators, rollback`) that Darwin Mode evolves and that round-trips with `HarnessGenome`. Its governing principle — "Darwin Mode mutates structured policies, not prompts" — is directly relevant to §4 below.
- **`harness-score` / `harness-genome` / `harness-mcp-scan`** (ruflo-side skills reading `metaharness score`/`genome`/`mcp-scan` subprocess output, per ruflo ADR-150): capability, security-scope, and evaluation data already computed, just not exported in a standard external schema.
- **Three-layer marketplace provenance (ADR-005)** and the IPFS/Pinata plugin registry: the *internal* Cognitum discovery surface for harnesses and plugins.

None of these give a generated harness, or the agents/MCP servers inside it, an identity or capability description that a system **outside** this project can verify or discover. AGNTCY (Linux Foundation governed, ~150 participating members per the brief) offers three components that map directly onto that gap: **Identity** (external identity providers, W3C DIDs, verifiable credentials, task-specific badges), **Directory** (OASF capability records + distributed discovery, signed claims, provenance, dependency relationships, version histories), and **Observe** (OpenTelemetry semantic-convention extensions for agents). This ADR adopts all three at the build/manifest layer.

## 2. Decision

### 2.1 AGNTCY identity in the harness manifest

Add an `identity` block to `.harness/manifest.json` (and its HarnessSpec, ADR-159, serialization), alongside — not replacing — the existing witness manifest (ADR-011):

```json
{
  "identity": {
    "subject": "did:agntcy:cognitum:researcher",
    "issuer": "cognitum.one",
    "badges": ["code.read", "tests.execute"],
    "tenant": "customer_117"
  }
}
```

- `subject` is a W3C DID minted per-harness (or per-tenant-deployment) through AGNTCY's identity-provider integration.
- `badges` are task-specific verifiable credentials. The natural source is the harness's own tool-policy allowlist, already computed by `mcp-scan`/`threat-model` — every allowed tool scope becomes a candidate badge, not an arbitrary string a generator invents.
- `tenant` maps onto existing Cognitum tenancy rather than introducing a second tenant model.
- The identity block is **signed as part of the existing witness manifest** (ADR-011 §"two manifests per release"), not a third independent signature scheme. `did:agntcy` verification (external, multi-vendor trust) and Ed25519 witness verification (internal build-provenance trust) are complementary, matching the brief's framing that this "maps directly onto Cognitum tenancy, approval, and deployment receipts."

Estimated effort: 10–15 engineering days — identity-provider integration, manifest/HarnessSpec schema addition, witness-signing wire-up.

### 2.2 OASF export and AGNTCY Directory publishing

Every generated harness exports an Open Agentic Schema Framework (OASF) record: capabilities, supported protocols, model requirements, resource envelope, security scopes, evaluation history, deployment options, pricing/metering class. Publish it to the AGNTCY Directory (capability matching, signed claims, provenance, dependency relationships, version histories, distributed discovery).

**Honest boundary**: evaluation history and security scopes are not new data to invent. §2.1's `badges` source and the existing `harness-score`/`harness-genome`/`harness-mcp-scan` outputs are already-computed facts; OASF export is a *projection* of those facts into a standard schema, not a new evaluation pipeline. If a field OASF expects (e.g. "pricing and metering class") has no existing internal source, the exporter must fail closed on that field rather than fabricate a plausible-looking value to satisfy the schema.

This becomes the external federation layer for the Cog marketplace (per the brief) — complementing, not replacing, ADR-005's three-layer provenance and the IPFS/Pinata registry, which remain the *internal* Cognitum discovery surface.

Estimated effort: 7–10 days.

### 2.3 AGNTCY semantic observability

Map every harness execution's spans onto AGNTCY's OpenTelemetry semantic-convention extensions: `agent.identity`, `agent.capability`, `agent.intent`, `agent.parent`, `coordination.episode`, `authorization.decision`, `model.route`, `memory.provenance`, `evaluation.score`, `receipt.hash`.

- `model.route`, `memory.provenance`, and `evaluation.score` already have real, measured producers in this repo: model routing (the escalation-router ADR line, e.g. ADR-040/043/148), memory provenance (ADR-074 ruVector memory fabric, ADR-161 memory tiers), and evaluation score (the frozen `meetsPromotionRule` scorer, ADR-072). This work is an OTel **exporter** over existing internal telemetry, not new instrumentation logic.
- `coordination.episode` and `authorization.decision` are populated at runtime by RuFlo's SLIM/CASA integration (companion ADR-324). This ADR commits only to emitting them in the correct shape when the harness *is* running under RuFlo coordination — a harness running standalone (no RuFlo) omits those two attributes rather than fabricating placeholder values.

Net effect: MetaHarness executions become observable through standard enterprise telemetry (whatever already consumes OTel) instead of requiring a proprietary dashboard — matching the brief exactly.

Estimated effort: 5–8 days.

## 3. What this ADR does not cover (see companion ADR-324)

SLIM transport, CASA intent-scoped-authorization *enforcement*, and IOC Layer 9 cognition envelopes are runtime coordination concerns owned by RuFlo, not build-time manifest concerns owned by MetaHarness. This ADR's only touchpoint with CASA is that MetaHarness is the natural place to *compile* a stated objective into the bounded authority envelope CASA enforces (§4) — MetaHarness never enforces it.

## 4. The CASA authority-envelope compiler

CASA answers "is this invocation necessary and permitted for the user's current *intent*," not just "can agent A invoke tool B." MetaHarness — already the thing that turns a stated objective into a generated harness with a bounded tool policy (HarnessSpec guards, ADR-159; the declared MCP surface from `mcp-scan`) — is the natural compiler from free-text intent into a deterministic authority envelope:

```json
{
  "objective": "review repository security",
  "allow": ["repository.read", "tests.execute"],
  "deny": ["git.push", "secret.export", "deployment.create"],
  "budget_usd": 8,
  "expires_at": "2026-07-30T22:00:00Z"
}
```

**This is the single most important design constraint in the whole integration, so it is stated plainly rather than implied**: the translation step (free text → structured envelope) may use an LLM. Enforcement must not. The compiled envelope is a bounded schema — explicit resource strings, an explicit deny list, a numeric budget, an expiry timestamp — checked by deterministic code, never by asking a model at invocation time whether an action "seems fine." Deny-by-default: anything not in `allow` is denied. This is HarnessSpec's own philosophy (ADR-159: "Darwin Mode mutates structured policies, not prompts") applied one level up — from the harness's own tool policy to the per-session authority a user's stated intent grants it. Meta LLM enforces `budget_usd` and provider policy; CASA enforces network/tool authority against `allow`/`deny`; RuFlo (ADR-324) logs every decision into signed receipts. MetaHarness's responsibility stops at producing the envelope — never at deciding whether an in-flight call is safe.

Estimated effort: 15–25 days (shared with the runtime enforcement half in ADR-324: compiler + schema + translation-quality tests here; wiring + enforcement + bypass-attempt tests + receipts there).

## 5. Package and roadmap

Ship a new `@metaharness/agntcy` package — mirrors the existing `@metaharness/darwin`, `@metaharness/redblue`, `@metaharness/flywheel` sibling-package pattern: optional peer, never a hard kernel dependency, consistent with ADR-002's kernel-boundary discipline and ruflo's own ADR-150 "removable augmentation" precedent for this project's own packages.

Phased delivery (shared across this ADR and ruflo ADR-324; roughly two engineers):

- **Phase 1 (~4 weeks)** — OASF records, Directory publishing, identity verification, OpenTelemetry spans: this ADR's §2.1/2.2/2.3, in full.
- **Phase 2 (~6 weeks)** — SLIM transport + CASA enforcement: owned by ADR-324. This ADR's only Phase-2 deliverable is the intent→envelope compiler (§4), which unblocks CASA enforcement but does not implement it.
- **Phase 3 (~4 weeks)** — native IOC Layer 9 negotiation, submitted upstream (schemas are Apache-2.0 with existing Python/Go bindings; a native Rust implementation, owned by ADR-324's `ruflo agntcy` crate, would be a meaningful ecosystem contribution). This ADR's only Phase-3 involvement is exporting IOC-shaped OASF capability fields if the negotiated protocol requires them.

## 6. Acceptance test

Shared with ADR-324, split by ownership: generate a MetaHarness agent, publish its signed OASF record (this ADR), discover it from a second network (this ADR, via Directory), verify its AGNTCY identity (this ADR §2.1), invoke it through SLIM (ADR-324), reject one out-of-scope tool call through CASA (ADR-324, using this ADR's compiled envelope), and reconstruct the complete run from OpenTelemetry spans and Flywheel receipts (this ADR's §2.3 spans + ADR-324's receipts).

## 7. Alternatives considered

- **Inventing a bespoke identity/discovery scheme instead of adopting AGNTCY.** Rejected — the existing witness manifest (ADR-011) already proves the value of a signed provenance artifact; AGNTCY gives the same idea *external, multi-vendor* verifiability without this project building and governing its own federation protocol. "Complementary, not competitive" per the brief.
- **Letting MetaHarness itself enforce CASA at generation time** (bake a fixed policy into the harness). Rejected — objectives are per-session/per-tenant, not per-harness-build; baking them in would require regenerating a harness for every new user intent, defeating the point of a reusable generated harness.
- **Skipping the OTel semantic-convention mapping**, keeping only this repo's internal telemetry vocabulary. Rejected for Phase 1 given the cost (5–8 days) relative to the enterprise-adoption unlock (no proprietary-dashboard requirement).

## 8. Risks / honest boundaries

- AGNTCY is an early, Cisco-Outshift-led ecosystem. Linux Foundation governance de-risks single-vendor lock-in per the brief, but the Identity/Directory/Observe schema surface can still move before 1.0 stability. `@metaharness/agntcy` ships as an optional, versioned peer package precisely so a breaking upstream change never blocks a harness build.
- OASF's "evaluation history" and "pricing and metering class" fields need a stable internal source before export; §2.2 is explicitly scoped to *already-computed* facts rather than inventing new evaluation machinery under schema-completeness pressure.
- The CASA compiler (§4) is the highest-risk, highest-value piece here and is **not** claimed as solved by this ADR — it is scoped as a Phase-1/2-boundary deliverable requiring its own test contract: translation-quality tests, and — more importantly — enforcement-bypass tests proving no code path lets a translated envelope skip deterministic checking.

## References

- Cisco AGNTCY overview — https://outshift.cisco.com/the-internet-of-agents/agntcy
- AGNTCY Identity — https://github.com/agntcy/identity
- AGNTCY Directory — https://github.com/agntcy/dir
- AGNTCY Observe — https://github.com/agntcy/observe
- SLIM architecture — https://github.com/agntcy/slim
- Cisco CASA overview — https://outshift.cisco.com/blog/ai-ml/continuous-agentic-semantic-authorization-for-mas
- IOC protocol repository — https://github.com/outshift-open/ioc-protocols-models
- Companion: ruflo ADR-324 (runtime half of this integration)
