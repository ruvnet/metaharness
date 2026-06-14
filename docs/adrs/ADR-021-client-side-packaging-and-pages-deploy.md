# ADR-021: Client-Side Packaging + GitHub Pages Deploy

**Status**: Accepted
**Date**: 2026-06-14
**Related**: ADR-007 (CI guards), ADR-011 (witness + provenance), ADR-020 (web generator UI)

## Context

ADR-020 commits to a browser-only generator: nothing leaves the user's machine, and the page must run anywhere. That decision is only real if the *packaging and hosting* story keeps the promise — a single misplaced backend call, an absolute asset path, or an un-gated deploy would quietly break it.

Two concrete problems have to be solved:

1. **In-browser packaging.** The generator's product is a zip of small text files. It must be assembled and handed to the user without a server round-trip, and ideally be byte-stable for identical inputs so it composes cleanly with the provenance story (ADR-011) later.
2. **Static hosting under a project path.** GitHub Pages serves this repo's site from `https://<owner>.github.io/agent-harness-generator/` — a *subpath*, not a domain root. A Vite app built with the default `base: '/'` ships absolute `/assets/...` URLs that 404 under a subpath. SPA deep links 404 too, because Pages has no server-side rewrite.

## Decision

### Packaging: JSZip + Blob, deterministic dates

`src/generator/zip.ts` builds the archive with `JSZip` and triggers download via a `Blob` + `URL.createObjectURL` + a synthetic `<a download>` click. Every entry is written with a **fixed timestamp** (`2020-01-01T00:00:00Z`) so the same inputs yield the same archive bytes — no wall-clock entropy leaking into the zip. The object URL is revoked on the next tick so the click has time to start the download. `downloadBlob` is a no-op when `document` is undefined, so the module is safe to import in the Node test environment.

### Base path: env-driven, Pages-default

`vite.config.ts` reads `base` from `VITE_BASE`, defaulting to `/agent-harness-generator/`:

```ts
const base = process.env.VITE_BASE ?? '/agent-harness-generator/';
```

- **Production Pages build** uses the default — assets resolve under the project subpath.
- **Local dev, `vite preview`, e2e, and screenshots** pass `VITE_BASE=/` so they serve from root with no subpath gymnastics.
- **Custom domain / root deploy** is a one-env-var override, not a code change.

### SPA + Pages fallback

The deploy copies `dist/index.html` to `dist/404.html` so any deep link Pages can't resolve falls back to the app shell, and `touch dist/.nojekyll` disables Jekyll so paths beginning with `_` (Vite chunks) are served verbatim.

### Deploy is gated, not just pushed

`.github/workflows/pages.yml` runs on pushes to `main` that touch `apps/web-ui/**` (or the workflow itself), with `workflow_dispatch` for manual runs. The `build` job is the gate:

1. `npm ci`
2. `npm test` — the 27 generator unit tests
3. `npx playwright install --with-deps chromium` + `npm run e2e` — desktop + mobile, asserting zero console errors and working downloads
4. `npm run build` (Pages base) → `cp dist/index.html dist/404.html` → `touch dist/.nojekyll`
5. `upload-pages-artifact`

The `deploy` job (`needs: build`) publishes via `actions/deploy-pages@v4` under the `github-pages` environment. **A red unit or e2e run blocks the deploy** — the page that ships is always one that passed in a real browser. `concurrency: { group: pages, cancel-in-progress: true }` means a newer push supersedes an in-flight deploy rather than racing it.

### Isolation from the kernel build

`apps/web-ui` is deliberately **outside** the root `package.json` `workspaces` glob (`packages/*`). It carries its own `package-lock.json` and `node_modules`. Consequences:

- The Rust/WASM kernel build, the root `npm test`, and the release orchestration (ADR-019) are untouched by the UI's React/Playwright dependency tree.
- The Pages workflow is the *only* CI that installs the UI's deps, keeping the heavyweight `ci.yml` matrix lean.
- The trade-off — the UI isn't covered by the root `npm test -ws` — is accepted because `pages.yml` runs the UI's own gates on every UI change.

## Consequences

**What gets better**

- The page is a static artifact a CDN can cache forever; there is no origin to operate, rate-limit, or secure.
- Deterministic zips keep the door open to witness-signing generated archives later (ADR-011) without fighting timestamp noise.
- A broken UI cannot reach production — the deploy is behind the same browser the user will use.

**What this costs**

- A second `node_modules` and lockfile in the repo. Acceptable for the isolation it buys.
- Playwright's browser download (~175 MB) runs in the Pages job; mitigated by `actions/setup-node` npm caching and the `paths:` filter so the job only fires on UI changes.
- The base-path default means *forking the repo under a different name* requires setting `VITE_BASE` (or renaming) — documented in `apps/web-ui/README.md`.

**What explicitly does not change**

- No secret is needed to deploy: Pages uses the workflow's OIDC `id-token`, not a stored token. This sits beside, not inside, the GCP-gated npm publish pipeline (ADR-019) — different surface, different trust model.

## Alternatives Considered

- **Hash-router instead of the 404.html fallback.** Avoids the copy step but puts `#/...` in every URL; the app is effectively single-route today, so the fallback is cheaper and keeps URLs clean.
- **`peaceiris/actions-gh-pages` pushing to a `gh-pages` branch.** Works, but the first-party `actions/deploy-pages` + `upload-pages-artifact` flow needs no PAT and no branch to maintain. Chosen for the smaller trust surface.
- **Hard-code `base: '/agent-harness-generator/'`.** Simpler, but breaks local `vite preview`, the e2e run, and the screenshot script, all of which serve from root. The env-var indirection is one line and removes that whole class of "works in CI, 404s locally" friction.
- **Stream the zip from a serverless function for very large scaffolds.** Unnecessary at this scale (kilobytes) and would reintroduce exactly the backend ADR-020 spent its decision removing.

## Test Contract

For this decision to be considered shipped:

- **Packaging.** `zipFiles` / `zipFilesUnder` produce a `Blob`; `totalBytes` is exercised by the scaffold tests; determinism of the *file map* is asserted in `scaffold.test.ts` and the fixed-date policy keeps the *archive* deterministic for identical inputs.
- **Base-path correctness.** The e2e suite builds and serves with `VITE_BASE=/` and loads with zero console errors — catching asset-path regressions. The Pages build uses the default base; a 404 of `dist/assets/*` would surface as a blank page the e2e load-check would fail on if mis-based.
- **Deploy gating.** `pages.yml` ordering (`test` and `e2e` before `build`/`deploy`, `deploy needs build`) is the executable contract: deploy cannot run unless the browser-verified build is green.

## References

- ADR-020 — the product this packaging serves
- ADR-007 — CI guards (the gating philosophy this extends to the UI)
- GitHub Pages with a custom action: https://github.com/actions/deploy-pages
- Vite `base` for non-root deploys: https://vitejs.dev/guide/static-deploy.html#github-pages
