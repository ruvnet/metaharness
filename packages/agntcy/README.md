# @metaharness/agntcy — AGNTCY build-time integration

> **Optional peer package. Never a hard kernel dependency.** MetaHarness generates
> and evolves harnesses without this package present; every harness you have
> already generated keeps working if `@metaharness/agntcy` is never installed,
> or is removed later. This follows ADR-002's kernel-boundary discipline (the
> kernel is the smallest stable surface every harness needs, independent of
> identity and content) and ADR-237 §5, which places this package alongside the
> existing `@metaharness/darwin`, `@metaharness/redblue`, and
> `@metaharness/flywheel` sibling-package pattern: augmentation you opt into,
> not a load-bearing part of the generator.

```bash
npm install --save-optional @metaharness/agntcy
```

## What this is

[AGNTCY](https://outshift.cisco.com/the-internet-of-agents/agntcy) is a Cisco
Outshift–led, Linux Foundation–governed effort to standardize how agents get an
**identity**, **discover each other's capabilities**, and get **observed**
across organizational boundaries. `@metaharness/agntcy` is the build-time half
of this project's integration with that ecosystem (the runtime half — SLIM
transport and CASA enforcement — lives in ruflo's companion ADR-324; see
[ADR-237](../../docs/adrs/ADR-237-agntcy-identity-oasf-observability.md) for
the full decision record and how the two halves divide responsibility).

Four surfaces, each scoped to what MetaHarness can compute or compile today
without inventing facts it doesn't have:

1. **Identity** (`identity/`, ADR-237 §2.1) — mints a W3C DID per harness and
   derives verifiable-credential badges from the harness's own tool-policy
   allowlist (already computed by `mcp-scan`/`threat-model`), signed as part
   of the existing ADR-011 witness manifest rather than a second, competing
   signature scheme.
2. **OASF export + Directory publish** (`oasf/`, ADR-237 §2.2) — projects
   already-computed `harness-score` / `harness-genome` / `harness-mcp-scan`
   facts into the Open Agentic Schema Framework and publishes the record to
   the AGNTCY Directory for external, multi-vendor discovery. If an OASF field
   (e.g. pricing/metering class) has no existing internal source, the exporter
   fails closed on that field — it does not fabricate a plausible-looking
   value to satisfy the schema.
3. **Semantic observability** (ADR-237 §2.3) — an OpenTelemetry **exporter**
   over telemetry this repo already produces (model routing, memory
   provenance, evaluation score), mapped onto AGNTCY's semantic-convention
   attributes (`agent.identity`, `agent.capability`, `model.route`,
   `memory.provenance`, `evaluation.score`, `receipt.hash`, …). Two
   attributes — `coordination.episode` and `authorization.decision` — are only
   populated when the harness is running under RuFlo/CASA coordination; a
   standalone harness omits them rather than fabricating placeholder values.
4. **The CASA authority-envelope compiler** (`casa/`, ADR-237 §4) —
   deterministically compiles a stated objective into a bounded authority
   envelope (`allow`, `deny`, `budget_usd`, `expires_at`). The free-text →
   envelope *translation* step may use an LLM; the compiled envelope itself is
   a schema-validated, deny-by-default artifact checked by deterministic code.
   **This package compiles envelopes. It never enforces them.** Enforcement
   is owned by the runtime (ruflo ADR-324); MetaHarness's responsibility stops
   at producing the envelope.

## Status — no upstream AGNTCY npm packages exist yet (verified)

As of this package's initial scaffold, **zero AGNTCY-affiliated packages exist
on the npm registry under any plausible name** — `@agntcy/*`, `agntcy-*`,
`@outshift/*`, `@cisco/agntcy*`, and similar were checked and every one 404s.
The reference implementations that do exist are Python/Go, hosted directly on
GitHub (see links below), not published to npm or crates.io.

Given that, this package **must not** `require`/`import` any such package —
there is nothing real to import. Anywhere this package would call out to
AGNTCY infrastructure (identity-provider verification, Directory publish,
SLIM transport), the implementation is a **clearly-logged, clearly-erroring
stub gated behind a feature flag or config check** — e.g.

```
AGNTCY Directory publish is not configured — see ADR-324/ADR-237. Set
AGNTCY_DIRECTORY_ENDPOINT (and the matching identity-provider credentials) to
enable this call. No record was published.
```

never a call that silently succeeds or returns fabricated data. Logic that
*is* buildable without an external SDK today — OASF record shaping from
already-computed facts, DID/badge derivation, the CASA envelope schema and
compiler, and the OTel attribute constants — ships as real, tested code, not
placeholder TODOs.

Upstream references (schemas are Apache-2.0 with existing Python/Go bindings):

- AGNTCY overview — <https://outshift.cisco.com/the-internet-of-agents/agntcy>
- AGNTCY Identity — <https://github.com/agntcy/identity>
- AGNTCY Directory — <https://github.com/agntcy/dir>
- AGNTCY Observe — <https://github.com/agntcy/observe>
- SLIM architecture — <https://github.com/agntcy/slim>
- CASA overview — <https://outshift.cisco.com/blog/ai-ml/continuous-agentic-semantic-authorization-for-mas>
- IOC protocol repository — <https://github.com/outshift-open/ioc-protocols-models>

## Scope boundary vs. companion ADR-324

| | Owns | Never does |
|---|---|---|
| **This package** (`@metaharness/agntcy`, MetaHarness/build-time) | Identity minting + badges, OASF export, Directory publish, OTel exporter over existing telemetry, CASA envelope *compiler* | Enforce CASA at invocation time, run SLIM transport, decide whether an in-flight tool call is safe |
| **ruflo ADR-324** (RuFlo/runtime) | SLIM transport, CASA enforcement against compiled envelopes, IOC Layer 9 coordination events, signed receipts | Compile envelopes from free text, mint identities, export OASF records |

## Install / Build

```bash
npm install                         # from the monorepo root (workspaces)
npm run build -w @metaharness/agntcy
npm test  -w @metaharness/agntcy
```

## Dependencies

Dependency-free at the runtime layer, matching `@metaharness/redblue`,
`@metaharness/darwin`, and `@metaharness/flywheel`: no new external runtime
`dependencies` beyond Node built-ins. `typescript` and `vitest` are
`devDependencies` only, matching every other sibling package in this
monorepo.

## Current state

This is scaffolding. `src/index.ts` exports nothing yet — see the TODO block
at the top of that file for the `identity/`, `oasf/`, and `casa/` subpaths
landing in follow-up work, each implementing one numbered section of
[ADR-237](../../docs/adrs/ADR-237-agntcy-identity-oasf-observability.md).

## License

MIT — see [LICENSE](./LICENSE).
