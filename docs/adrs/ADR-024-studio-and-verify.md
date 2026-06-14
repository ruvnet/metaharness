# ADR-024: Agent Harness Studio + in-browser Verify

**Status**: Accepted
**Date**: 2026-06-14
**Related**: ADR-020 (web generator UI), ADR-022 (MCP primitive), ADR-023 (repo importer)

## Context

The web UI started as a two-mode generator (full harness / single artifact). Three things pulled it toward a product surface rather than a tool page: the repo importer (ADR-023) needs a home, MCP policy (ADR-022) needs a trust-check, and the project's positioning is "the agent harness supply chain — idea → harness → package → install → audit," not "a scaffold picker." The supply chain has a missing link in-browser: **trust**. A user can generate a harness but has no zero-install way to confirm it is well-formed and its MCP policy is safe before they ship it.

## Decision

Reframe the app as **Agent Harness Studio** with four tabs, and add a **Verify** capability that closes the trust link entirely client-side.

### Four tabs

- **Repo → Harness** — paste a URL, get a recommended editable plan (ADR-023).
- **Create harness** — the full branded-runtime builder (templates, primitives, MCP, policy). Accepts a `seed` config so a repo plan flows straight in via "Open in builder".
- **Skill / Agent / Command** — the Claude-artifact authoring path.
- **Verify** — drop a generated `.zip`; it is unzipped and checked in the browser.

### Verify is the in-browser trust link

`verifyFileMap(files)` is a pure verifier that runs the same *class* of checks as the CLI's `harness validate` + `mcp-scan`, over a file map: package.json parses + has a name + declares `@ruflo/kernel`; generator manifest present; at least one host adapter; **no unresolved `{{template vars}}`**; and — when an MCP surface exists — policy is default-deny, shell-gated, audited, and timeout-bounded; secrets (`.env`) denied. It returns pass/fail checks with severities and an overall `ok`.

The Verify tab unzips a download with JSZip (stripping the single `<root>/` prefix) and renders the report. Nothing is uploaded; the same engine verifies the live scaffold or any zip the user drops in.

### Seeding flow

`App` holds an optional `seed: HarnessConfig` and a `seedKey`. "Open in builder" sets both and switches tabs; `HarnessBuilder` is remounted via `key={seedKey}` so it re-initialises from the seed cleanly without entangling repo state with builder state.

## Consequences

**What gets better**

- The supply chain is now demonstrable end-to-end in one page: repo → plan → branded harness → **verify** → download.
- Verify reuses the generator's own types and (in spirit) the scanner's rules, so the browser trust-check and the CLI gate cannot drift far — and both are pure + tested.
- The Studio framing matches the product thesis without adding a backend.

**What this costs**

- A second, browser-resident verifier exists beside the CLI `mcp-scan`. They share intent and shape but not code (Node fs vs. file map). Accepted; both are small and pinned by tests.
- Four tabs is more surface to keep responsive; mitigated by the shared `Section`/`SegTabs` primitives already proven on mobile.

**What does not change**

- Still 100% client-side, GitHub-Pages-deployable, no upload. Verify strengthens that story rather than compromising it.

## Alternatives Considered

- **Keep verification CLI-only.** Rejected: the wedge is a zero-install trust check; sending a user to a terminal to validate a browser-generated zip breaks the flow.
- **One mega-form instead of tabs.** Rejected: repo-analysis, building, artifact-authoring, and verification are distinct jobs; tabs keep each legible on mobile.
- **Verify by re-generating and diffing.** Useful for drift but doesn't validate an *arbitrary* uploaded zip; the property-based `verifyFileMap` covers both.

## Test Contract

- `verifyFileMap` passes a freshly generated secure harness (`ok: true`); flags a tampered `package.json` (HIGH); flags a policy weakened to `allowShell`/non-default-deny (HIGH); treats an MCP-off harness as clean info. (`apps/web-ui/src/generator/__tests__/verify.test.ts`.)
- e2e: the four tabs render; Repo→Harness rejects a non-GitHub URL; Verify shows the dropzone + checklist. (`apps/web-ui/e2e/generator.spec.ts`.)

## References

- ADR-020 — the UI this extends · ADR-022 — the MCP policy Verify checks · ADR-023 — the repo plans that seed the builder
