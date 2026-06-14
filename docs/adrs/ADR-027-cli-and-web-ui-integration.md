# ADR-027: CLI and Web-UI Integration

**Status**: Accepted
**Date**: 2026-06-13
**Related**: ADR-003 (generator architecture), ADR-007 (CI guards), ADR-010 (TDD test contracts), ADR-019 (release orchestration), ADR-020 (web generator UI), ADR-021 (client-side packaging + Pages deploy), ADR-022 (MCP primitive), ADR-023 (Repo→Harness importer), ADR-024 (Studio + Verify), ADR-026 (CLI repo analyzer)
**Supersedes / Superseded-by**: none
**Renumbered**: originally drafted as ADR-022 on iter 55 before the PR #1 ADRs landed; renumbered to 027 to avoid collision with PR #1's ADR-022 (MCP primitive).

## Context

By iter 55, the project has TWO generator surfaces that can produce the same scaffolded harness:

1. **CLI generator** (`packages/create-agent-harness/`)
   - Node-only, npm-published
   - `npx create-agent-harness <name>` or `node packages/create-agent-harness/dist/bin.js`
   - 12 `harness` subcommands for the post-scaffold lifecycle (sign / verify / validate / publish / upgrade / mcp / federate / secrets / doctor / completions / sbom / audit)
   - Backed by `crates/kernel/` (Rust → WASM + NAPI)
   - Shipped to **npm** via the 11-package release pipeline (ADR-019)

2. **Web-UI generator** (`apps/web-ui/` — PR #1)
   - Browser-only (Vite + React + TS + Tailwind)
   - Two modes: full-harness scaffolding (byte-compatible .zip download) + skill/agent/command authoring (SKILL.md folder with YAML frontmatter)
   - Generator core **ported behaviour-for-behaviour** from the CLI renderer
   - 100% client-side — JSZip + Blob, nothing leaves the page
   - Shipped to **GitHub Pages** via `.github/workflows/pages.yml`

Both surfaces emit the SAME output for the SAME input. Without a deliberate integration contract, they will drift — and the CLI's witness/manifest tests, downstream marketplace entries (iter 27 + 28), and per-host validate checks (iter 30) will start producing different verdicts for "identical" harnesses.

This ADR defines the integration contract.

## Decision

### 1. Single source of truth for generation behaviour

The CLI's `packages/create-agent-harness/src/renderer.ts` is the **canonical** generator. Its behaviour — the `{{var}}` templating rules, `validateHarnessName()` constraints, per-host file shapes, the manifest fingerprint algorithm — defines what a "correct" harness looks like.

The web-UI's generator (`apps/web-ui/src/generator/`) is a **behaviour-port**. It does NOT import from `packages/create-agent-harness/` (different runtime constraints: no Node fs, must work in a browser sandbox). But it implements the same surface, and the **parity contract** below pins them together.

### 2. Parity contract enforced by tests

Both surfaces MUST produce byte-identical output for the same `(name, host, template, options)` tuple. Enforcement:

- `apps/web-ui/__tests__/parity.test.ts` (PR #1) — runs both generators against the same inputs and asserts `Buffer.equal()` on every file in the output.
- The fingerprint algorithm (used by `.harness/manifest.json`) is the load-bearing detail: if the two surfaces drift here, the iter-20 `harness validate` umbrella's `doctor` check will reject web-UI output as if it had been hand-edited.

A PR that breaks the parity test must either:
- Update both surfaces in lockstep, OR
- Document an intentional surface-specific divergence in a follow-up ADR (and add a fixture exclusion to the parity test).

### 3. Surface-specific extensions are allowed; asymmetric-features table is authoritative

The web-UI's **skill/agent/command authoring mode** (PR #1) has no CLI equivalent. That's fine — it's a strictly additive surface unique to the browser context (live editing, drag-drop, preview). The CLI continues to handle the post-scaffold lifecycle (sign / publish / upgrade) which the browser can't safely sandbox-execute.

Asymmetric features are explicitly allowed; the **shared subset** (full-harness scaffolding) stays byte-identical:

| Feature | CLI | Web-UI |
|---|---|---|
| Full-harness scaffolding | yes | yes (byte-identical to CLI) |
| Witness sign/verify (iter 3/8) | yes | no — key custody belongs out of browser |
| Validate umbrella (iter 20) | yes | no — Node-only ops |
| Publish to IPFS via Pinata (iter 46) | yes | no — CORS + JWT custody |
| Upgrade drift detection (iter 47) | yes | no — no fs access in browser |
| Federation (iter 9 + 40) | yes | no — Node-only transport |
| SBOM emit (iter 51) | yes | no — needs lockfile |
| Skill/agent/command authoring (SKILL.md emitter) | no | yes |
| Live preview / drag-drop | no | yes |
| Static-site download (zip) | no | yes |

### 4. Where each lives in the repo

```
crates/kernel/                        Rust kernel (both surfaces converge here via @ruflo/kernel)
packages/kernel-js/                   @ruflo/kernel runtime bridge (Node + browser)
packages/create-agent-harness/        CLI generator + 12 harness subcommands
apps/web-ui/                          Browser generator (Vite + React + TS) — PR #1
.github/workflows/ci.yml              CLI matrix (Rust + WASM + Node + Bench + pack+install)
.github/workflows/pages.yml           Web-UI build + Playwright + Pages deploy — PR #1
```

`apps/web-ui/` is **outside** the kernel/packages workspace deliberately, so:
- The web-UI build doesn't get pulled into `npm pack` for any published package (iter 25 pack-content invariants stay clean)
- The web-UI's Vite/React deps don't bloat the CLI's install size
- The Rust/WASM build pipeline (ADR-002a) is untouched by the new tree
- The iter-31 build-ordered topology stays a 4-phase npm-workspace build

### 5. Release coordination

Releases are **decoupled**:

| Pipeline | Trigger | What ships | ADR |
|---|---|---|---|
| CLI npm publish | Tag push `v*.*.*` | The 11-package npm workspace | ADR-019 |
| Web-UI Pages deploy | Push to main | Static site (vite build → GitHub Pages) | ADR-021 |

The web-UI **embeds** the generator-core's version (read from `apps/web-ui/package.json`); on a CLI release, the web-UI's next push picks up any kernel-WASM version bumps via its package.json deps. There is **no** synchronous "publish both at the same tag" requirement.

When a `harness validate` umbrella check would reject a downstream harness scaffolded by the web-UI as "wrong manifest hash", the cause is almost always **kernel version skew** — the CLI uses kernel v0.X.Y, the deployed Pages instance still uses v0.X.(Y-1). The parity test (point 2 above) is prevention; the kernel version in `meta.kernel_version` of the manifest is the diagnostic.

### 6. Test contract

| Test | Where | What it pins |
|---|---|---|
| Parity: byte-identical scaffold output | `apps/web-ui/__tests__/parity.test.ts` (PR #1) | (name, host, template) → same bytes both surfaces |
| Web-UI Playwright e2e | `apps/web-ui/__tests__/e2e/*.spec.ts` (PR #1) | Desktop + Pixel viewport, zero console errors, downloads work |
| CLI e2e lifecycle | `__tests__/e2e-lifecycle.test.ts` (iter 52) | All 12 harness subcommands work against scaffold output |
| Per-host validate sweep | `__tests__/e2e-scaffold-validate.test.ts` (iter 23 + 30) | Each of 6 hosts: scaffold + validate → HEALTHY |
| Plugin / marketplace schema | `__tests__/claude-marketplace-plugin.test.ts` (iter 24) | Both surfaces honour the marketplace plugin shape |
| Workflows structural | `__tests__/workflows.test.ts` (iter 30) | Catches drift between `ci.yml` + `pages.yml` |

When the parity test passes AND the CLI e2e lifecycle passes against web-UI output, the surfaces are integrated correctly. Any commit that breaks either chain is blocked at CI.

## Consequences

**Good**:

- The two surfaces can ship at their own cadence (CLI: tag-driven, web-UI: continuous-deploy) without weekly version-bump coordination ceremonies.
- New contributors can pick the surface that matches their context (CLI for ops, web-UI for content authoring) without learning both.
- The byte-parity contract gives users a guarantee: a harness scaffolded in the browser is bit-for-bit indistinguishable from one scaffolded in the terminal. `harness validate` reports the same verdict for both.
- The asymmetric-features table is explicit, so reviewers can reject "let's also add publish to the web-UI" with a clear rationale (key custody isn't safe in browsers).

**Hurts**:

- We now maintain TWO implementations of the generator (CLI's `renderer.ts` + the web-UI's port). Drift is a real risk; the parity test is the only thing preventing it.
- A `@ruflo/kernel` version bump can cause silent skew between an installed CLI (latest npm) and a stale Pages deploy. The diagnostic — `meta.kernel_version` in manifest — must be surfaced in `harness validate` failure output; if this becomes a real pain point, file a follow-up.
- The web-UI's CI workflow (`pages.yml`) is independent of the main CI matrix (`ci.yml`), so a green main CI does not imply a green web-UI build. Operators reviewing PRs touching both surfaces must check both badges.
- `node scripts/dev-toolkit.mjs` (iter 55) does not currently include the web-UI surface — TODO when PR #1 lands.

## Alternatives Considered

**A) Share the generator code via a real workspace package.** Rejected: the CLI's renderer uses Node-only constructs (fs, path, child_process for the scaffolder's witness signing path). A shared package would either bloat the web-UI bundle with Node polyfills or fragment into "core" + "node-only" + "browser-only" sub-packages — three places to update instead of two, with the same drift risk.

**B) WASM-only generator.** Compile the renderer to WASM and let both surfaces import it. Tempting (and aligned with ADR-002), but the renderer is a glue layer over template walking + variable substitution — Rust isn't a clear win for that workload, the WASM bundle size cost is real, and the parity test gives us the same guarantee without the rewrite.

**C) Drop one surface.** Rejected by user requirements: CLI is what experienced contributors and CI pipelines use; the web-UI is what newcomers and non-technical users want. Both serve real audiences.

**D) Run the CLI server-side from the web-UI.** Rejected: it converts the web-UI from "100% client-side" (ADR-021 promise) into "needs a backend." Pages + JSZip + Blob is the whole point.

## Test Contract

The integration is considered shipped when ALL of these are green:

| # | Test file | Iter | Status |
|---|---|---|---|
| 1 | Parity test: byte-identical bytes | `apps/web-ui/__tests__/parity.test.ts` (PR #1) | required |
| 2 | Web-UI Playwright e2e (desktop + Pixel) | `apps/web-ui/__tests__/e2e/*.spec.ts` (PR #1) | required |
| 3 | CLI e2e lifecycle | `__tests__/e2e-lifecycle.test.ts` (iter 52) | required |
| 4 | Per-host validate sweep | `__tests__/e2e-scaffold-validate.test.ts` (iter 23/30) | required |
| 5 | Plugin schema | `__tests__/claude-marketplace-plugin.test.ts` (iter 24) | required |
| 6 | Workflows structural | `__tests__/workflows.test.ts` (iter 30) | required (catches drift between `ci.yml` + `pages.yml`) |

A pull request that breaks any of (1)–(6) is blocked by branch protection until either fixed or accompanied by a superseding ADR.

## References

- ADR-003: Generator architecture (the canonical renderer)
- ADR-019: Release orchestration (decoupled cadence)
- ADR-020: Web generator UI (PR #1)
- ADR-021: Client-side packaging + Pages deploy (PR #1)
- PR #1: `feat(web-ui): browser-based agent harness generator + Claude skill/agent/command authoring` — https://github.com/ruvnet/agent-harness-generator/pull/1
- `__tests__/e2e-lifecycle.test.ts` (iter 52)
- `__tests__/workflows.test.ts` (iter 30)
