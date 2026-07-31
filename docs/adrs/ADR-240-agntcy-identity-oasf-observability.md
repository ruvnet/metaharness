# ADR-240: AGNTCY identity, OASF export, and semantic observability for generated harnesses

**Status**: Proposed
**Date**: 2026-07-30
**Project**: `ruvnet/agent-harness-generator`
**Deciders**: ruv
**Tags**: agntcy, outshift, oasf, identity, observability, federation, internet-of-cognition
**Extends**: ADR-002 (Kernel boundary), ADR-011 (Witness manifest + provenance), ADR-159 (HarnessSpec declarative policy), ADR-005 (Marketplace three-layer provenance)
**Companion**: ruflo ADR-380 (AGNTCY/Outshift runtime integration — SLIM transport, CASA enforcement, IOC Layer 9 coordination events). This ADR covers what MetaHarness produces at build/manifest time; ADR-380 covers what RuFlo does with it at runtime. Neither is complete without the other; they are numbered and shipped as a pair.
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
- `coordination.episode` and `authorization.decision` are populated at runtime by RuFlo's SLIM/CASA integration (companion ADR-380). This ADR commits only to emitting them in the correct shape when the harness *is* running under RuFlo coordination — a harness running standalone (no RuFlo) omits those two attributes rather than fabricating placeholder values.

Net effect: MetaHarness executions become observable through standard enterprise telemetry (whatever already consumes OTel) instead of requiring a proprietary dashboard — matching the brief exactly.

Estimated effort: 5–8 days.

## 3. What this ADR does not cover (see companion ADR-380)

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

**This is the single most important design constraint in the whole integration, so it is stated plainly rather than implied**: the translation step (free text → structured envelope) may use an LLM. Enforcement must not. The compiled envelope is a bounded schema — explicit resource strings, an explicit deny list, a numeric budget, an expiry timestamp — checked by deterministic code, never by asking a model at invocation time whether an action "seems fine." Deny-by-default: anything not in `allow` is denied. This is HarnessSpec's own philosophy (ADR-159: "Darwin Mode mutates structured policies, not prompts") applied one level up — from the harness's own tool policy to the per-session authority a user's stated intent grants it. Meta LLM enforces `budget_usd` and provider policy; CASA enforces network/tool authority against `allow`/`deny`; RuFlo (ADR-380) logs every decision into signed receipts. MetaHarness's responsibility stops at producing the envelope — never at deciding whether an in-flight call is safe.

Estimated effort: 15–25 days (shared with the runtime enforcement half in ADR-380: compiler + schema + translation-quality tests here; wiring + enforcement + bypass-attempt tests + receipts there).

## 5. Package and roadmap

Ship a new `@metaharness/agntcy` package — mirrors the existing `@metaharness/darwin`, `@metaharness/redblue`, `@metaharness/flywheel` sibling-package pattern: optional peer, never a hard kernel dependency, consistent with ADR-002's kernel-boundary discipline and ruflo's own ADR-150 "removable augmentation" precedent for this project's own packages.

Phased delivery (shared across this ADR and ruflo ADR-380; roughly two engineers):

- **Phase 1 (~4 weeks)** — OASF records, Directory publishing, identity verification, OpenTelemetry spans: this ADR's §2.1/2.2/2.3, in full.
- **Phase 2 (~6 weeks)** — SLIM transport + CASA enforcement: owned by ADR-380. This ADR's only Phase-2 deliverable is the intent→envelope compiler (§4), which unblocks CASA enforcement but does not implement it.
- **Phase 3 (~4 weeks)** — native IOC Layer 9 negotiation, submitted upstream (schemas are Apache-2.0 with existing Python/Go bindings; a native Rust implementation, owned by ADR-380's `ruflo agntcy` crate, would be a meaningful ecosystem contribution). This ADR's only Phase-3 involvement is exporting IOC-shaped OASF capability fields if the negotiated protocol requires them.

## 6. Acceptance test

Shared with ADR-380, split by ownership: generate a MetaHarness agent, publish its signed OASF record (this ADR), discover it from a second network (this ADR, via Directory), verify its AGNTCY identity (this ADR §2.1), invoke it through SLIM (ADR-380), reject one out-of-scope tool call through CASA (ADR-380, using this ADR's compiled envelope), and reconstruct the complete run from OpenTelemetry spans and Flywheel receipts (this ADR's §2.3 spans + ADR-380's receipts).

## 7. Alternatives considered

- **Inventing a bespoke identity/discovery scheme instead of adopting AGNTCY.** Rejected — the existing witness manifest (ADR-011) already proves the value of a signed provenance artifact; AGNTCY gives the same idea *external, multi-vendor* verifiability without this project building and governing its own federation protocol. "Complementary, not competitive" per the brief.
- **Letting MetaHarness itself enforce CASA at generation time** (bake a fixed policy into the harness). Rejected — objectives are per-session/per-tenant, not per-harness-build; baking them in would require regenerating a harness for every new user intent, defeating the point of a reusable generated harness.
- **Skipping the OTel semantic-convention mapping**, keeping only this repo's internal telemetry vocabulary. Rejected for Phase 1 given the cost (5–8 days) relative to the enterprise-adoption unlock (no proprietary-dashboard requirement).

## 8. Risks / honest boundaries

- AGNTCY is an early, Cisco-Outshift-led ecosystem. Linux Foundation governance de-risks single-vendor lock-in per the brief, but the Identity/Directory/Observe schema surface can still move before 1.0 stability. `@metaharness/agntcy` ships as an optional, versioned peer package precisely so a breaking upstream change never blocks a harness build.
- OASF's "evaluation history" and "pricing and metering class" fields need a stable internal source before export; §2.2 is explicitly scoped to *already-computed* facts rather than inventing new evaluation machinery under schema-completeness pressure.
- The CASA compiler (§4) is the highest-risk, highest-value piece here and is **not** claimed as solved by this ADR — it is scoped as a Phase-1/2-boundary deliverable requiring its own test contract: translation-quality tests, and — more importantly — enforcement-bypass tests proving no code path lets a translated envelope skip deterministic checking.

## Update (2026-07-31) — corrected: real AGNTCY Directory package, live-integrated

This ADR's original text stated no AGNTCY npm package existed under any
plausible name. **That was wrong for the Directory piece** — corrected
here rather than silently rewritten, per this repo's own norms.

The real Directory SDK is **`agntcy-dir`** (npm, v1.5.0, unscoped — the
original check only tried scoped guesses like `@agntcy/dir`).
`oasf/publish.ts` now uses it for real: push, publish, and an independent
lookup, all verified against a real, locally-run Directory server (Go
apiserver + zot OCI registry + postgres, built and run from
[agntcy/dir](https://github.com/agntcy/dir)'s own
`install/docker/docker-compose.yml`).

Getting there surfaced a real, reproducible bug in the live server's
schema validator: `skills[].name` is rejected in every format tried
(the taxonomy's own real dotted paths from
[agntcy/oasf](https://github.com/agntcy/oasf), dot-separated, bare leaf,
human caption) — only a bare numeric `id` succeeds. Investigated
`agntcy/oasf-sdk` first, hoping to find (and possibly fix) the actual
lookup logic; that package turned out to be an HTTP client against a
remote, hosted validation service (`schema.oasf.outshift.com`), with no
local source to patch — so this shipped as an issue, not a PR:
[agntcy/dir#1943](https://github.com/agntcy/dir/issues/1943).

**AGNTCY Identity** (github.com/agntcy/identity) really is Go-only with
no JS/TS SDK — checked directly. That specific stub
(`identity/sign.ts`'s witness-signing TODO) was correct as originally
written and remains unchanged.

**SLIM** (companion ruflo ADR-380) also turned out to have a real,
published package (`@agntcy/slim-bindings`) rather than none — see that
ADR's own update section for the (different, upstream-packaging) reason
it's still not live-connectable today.

## Update (2026-07-31, part 2) — full taxonomy mapping, and how deep the id bug goes

The one deliberate gap this ADR's original §2.2 left open — "no real
taxonomy-mapping table from internal capability names onto AGNTCY's numeric
skill taxonomy" — is now real: `scripts/generate-oasf-taxonomy.mjs` walks a
fresh `agntcy/oasf` checkout's `schema/skills/**` and emits
`src/oasf/taxonomy.generated.json` (364 genuine leaf skills, composite ids
computed directly from each file's own `uid`/`extends` fields). This also
resolved a genuine ambiguity in the original derivation: a file sharing its
own subcategory directory's name (e.g. `code_generation/code_generation.json`)
is the *subcategory's* definition, not a leaf under itself, and the
generator now correctly excludes it. `KNOWN_AGENT_SKILLS` maps this repo's
*real* internal capability vocabulary (`harness-genome`'s actual
`plan.agents`/`plan.skills`/`agent_topology` ids — traced through
`create-agent-harness/src/analyze-repo.ts` and `genome-scorers.ts`, not the
placeholder names the original 5-entry table used) onto that generated data,
28 of 31 real names mapped, each id asserted by a test to exist in the
generated taxonomy.

Live-testing this surfaced a materially deeper version of the
`agntcy/dir#1943` bug than originally understood: it isn't just `name` that
the live Directory server's validator rejects — sending a bare, structurally
correct numeric `id` also fails for nearly everything. Of 9 real ids
spot-tested against the live server (reproducible across a container
restart), only `id=60101` was accepted; every other one, including
well-established subcategories like `software_testing` and
`application_security`, came back `no class is defined for <id>`. Posted as
a follow-up on the same issue with a full repro.

Consequence: `oasf/publish.ts` does **not** send the real derived ids on the
wire today — doing so would make live pushes fail for almost every real
capability. It sends the one empirically-confirmed-good id
(`CONFIRMED_LIVE_SKILL`, `SEND_REAL_TAXONOMY_IDS = false`) while recording
every capability's real, correctly-derived taxonomy id in
`annotations['skill.taxonomyId.*']` — nothing is silently dropped, and
flipping that one flag is the entire fix once upstream's validator catches
up to the public schema tree.

Also implemented in this pass: `oasf/publish.ts` no longer forces the SDK's
insecure plaintext `Config` default. It now builds a `Config` via the SDK's
own `Config.loadFromEnv()` (so `DIRECTORY_CLIENT_AUTH_MODE=tls`/`x509`/`jwt`
plus the matching cert/key env vars work automatically) or accepts a
pre-configured `Config` from the caller, and rebuilds server-address
overrides through the real `Config` constructor rather than a raw property
assignment — the latter was tried first and is a real bug: the constructor
normalizes a bare `host:port` into a scheme-prefixed URL depending on
`authMode`, and a plain assignment skips that, which the transport layer
then rejects with `Invalid URL`. Both this and the TLS-mode wiring are
covered by new tests exercising the SDK's real `createTLSTransport`
validation path, not mocks.

## Update (2026-07-31, part 3) — resolved: it was our bug, not upstream's

The "materially deeper" `agntcy/dir#1943` finding above (only `id=60101`
accepted, everything else rejected) had a root cause, and it wasn't the
live server's validator — it was this file. Upstream maintainer
**@akijakya** identified it directly: the pushed record declared
`schema_version: '0.8.0'` while every id/name being tested came from OASF
**1.1.0**'s taxonomy. The Directory server validates a skill against the
taxonomy for the record's *own declared* `schema_version` — so every
1.1.0-derived id was checked against the 0.8.0 taxonomy and correctly
rejected. `id=60101` only ever "worked" by coincidence: 0.8.0 happens to
have an unrelated skill ("indexing") at that same numeric slot.

Fixed: `schema_version` is now `'1.1.0'`, matching the taxonomy this file
actually generates from. Re-tested live — **all 9 previously-"broken" ids
now push successfully**, and sending `id` together with the taxonomy's own
dotted `name` (the self-documenting form, not id-only) works too. Removed
the `SEND_REAL_TAXONOMY_IDS` workaround flag entirely — `KNOWN_AGENT_SKILLS`
now sends real `{id, name}` pairs on the wire unconditionally, verified
end-to-end with real internal capabilities (`orchestrator`, `maintainer`)
that previously required the confirmed-good fallback.

Closed [agntcy/dir#1943](https://github.com/agntcy/dir/issues/1943) with
the resolution and a thank-you to @akijakya for the fast, precise diagnosis.

**agntcy/slim#1916 also resolved**, on the SLIM maintainers' side: they've
moved off `uniffi-bindgen-react-native` onto `@ubjs/core`/`@ubjs/node`
(compiled output) in the `alpha` dist-tag. Verified live in the companion
ruflo ADR-380 package — a real server bring-up + client connect + graceful
shutdown against `@agntcy/slim-bindings@2.0.0-alpha.5` succeeds under plain
Node with zero errors. See that ADR's own update section for the pinned
version and test changes.

## References

- Cisco AGNTCY overview — https://outshift.cisco.com/the-internet-of-agents/agntcy
- AGNTCY Identity — https://github.com/agntcy/identity
- AGNTCY Directory — https://github.com/agntcy/dir
- AGNTCY Observe — https://github.com/agntcy/observe
- SLIM architecture — https://github.com/agntcy/slim
- Cisco CASA overview — https://outshift.cisco.com/blog/ai-ml/continuous-agentic-semantic-authorization-for-mas
- IOC protocol repository — https://github.com/outshift-open/ioc-protocols-models
- Companion: ruflo ADR-380 (runtime half of this integration)
