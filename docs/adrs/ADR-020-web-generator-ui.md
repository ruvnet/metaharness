# ADR-020: Web Generator UI

**Status**: Accepted
**Date**: 2026-06-14
**Related**: ADR-003 (generator architecture), ADR-004 (host integration model), ADR-005 (marketplace plugin design), ADR-015 (naming + branding policy), ADR-021 (client-side packaging + Pages deploy)

## Context

`create-agent-harness` is a terminal-first experience: `npx create-agent-harness <name>`, answer prompts, get a scaffold. That is the right shape for harness authors who already live in a shell, but it excludes three populations the project wants:

1. **People evaluating the project** who will not run an unknown `npx` command against their machine before they understand what it produces.
2. **Claude desktop / claude.ai users** who want a single `SKILL.md` folder to drop into their skills directory and have no reason to install a Node toolchain to get one.
3. **Mobile / tablet visitors** arriving from a README badge or a social link, for whom a CLI is simply unreachable.

[Ruflo](https://github.com/ruvnet/ruflo) already proved the pattern with its [goal UI](https://goal.ruv.io) — a browser front-end that makes the harness's value legible without an install. We want the equivalent on-ramp for the *meta*-harness: a place you can compose a harness, see exactly what it emits, and walk away with a zip — no account, no backend, no install.

The hard constraint is **trust and reach**: the page must run anywhere a browser runs, must not exfiltrate the user's inputs to a server, and must produce output that is byte-for-byte what the CLI would have produced (ADR-003), so the web path is never a second-class, drifting fork of the generator.

## Decision

Ship `apps/web-ui` — a client-only single-page app (Vite + React + TypeScript + Tailwind) that composes harnesses and Claude artifacts entirely in the browser and downloads them as a zip. Deployment and the static-only packaging rules are split into ADR-021; this ADR governs the *product surface and the generation contract*.

### Two modes, one generator

- **Full harness** — name, description, host(s), template, kernel options (memory / routing / marketplace), and a composable pick-list of agents / skills / commands. A live file tree + file viewer shows the exact scaffold; "Download .zip" packages it under a `<name>/` root.
- **Skill / Agent / Command** — author or pick a single artifact and download it as drop-in markdown. Skills emit a `SKILL.md` with YAML frontmatter in their own folder — exactly the shape Claude desktop and claude.ai accept — so the output is usable with zero post-processing.

### Generation parity is the load-bearing rule

The browser generator does **not** invent its own templating. `apps/web-ui/src/generator/render.ts` is a behaviour-for-behaviour port of `packages/create-agent-harness/src/renderer.ts`:

- the same `{{var}}` Mustache substitution, same "leave unresolved vars in place" contract;
- the same `validateHarnessName` npm/kebab rules (leading letter, no `--`, no trailing `-`, ≤214 chars);
- the same file shapes per host (`.claude/settings.json`, `.codex/config.toml` TOML tables, pi.dev `AGENTS.md`/`SYSTEM.md`, Hermes `cli-config.yaml`, OpenClaw `openclaw.json`, RVM manifest) as the host adapters defined in ADR-004.

A parity test (`__tests__/render.test.ts`) pins the renderer's behaviour so the two implementations cannot silently diverge. If the CLI's contract changes, the port must change with it — and the test is the tripwire.

### The catalog mirrors shipped content

The pickable agents / skills / commands are not freeform — they mirror what already ships in this repo (the `vertical_devops` template's four agents; the `.claude-plugin` skills like `create-harness`, `validate-harness`, `verify-witness`). The web UI is therefore a *view onto the real catalog*, not a parallel content set that has to be maintained twice.

### No backend, by construction

Zipping is `JSZip` in the browser; download is a `Blob` + object URL. The string "100% client-side · nothing leaves your browser" in the header is a promise the architecture keeps — there is no fetch to any origin in the generation path. This is what makes the page safe to use on a work machine and trivially cacheable on a CDN.

## Consequences

**What gets better**

- A no-install, mobile-friendly on-ramp that doubles as living documentation of what the generator emits.
- Claude users get drop-in `SKILL.md` folders without touching npm.
- The live preview makes the scaffold legible *before* download — the single best argument for the project is now one click, not one `npx`.

**What this costs**

- A second implementation of the generation logic now exists in TS for the browser. The parity test mitigates drift but does not eliminate the maintenance tax — every host-shape change is now a two-file change.
- The catalog content is duplicated as data in `catalog.ts`. Acceptable while the catalog is small; ADR-021's follow-up note tracks generating it from the template manifests if it grows.
- React + JSZip is ~90 KB gzipped. Fine for a tool page; budgeted and asserted in ADR-021.

**What explicitly does not change**

- The CLI remains the source of truth and the only path that signs a witness manifest (ADR-011). The web UI emits a *provenance stub* and tells the user to run `harness verify-witness` / `publish-harness` to sign — it never claims to have signed something it did not.
- `npm publish` is never performed from the browser. The web UI's product is a zip, full stop.

## Alternatives Considered

- **Server-rendered generator (Next.js + an API route that runs the real CLI).** Rejected: it reintroduces a backend, a place inputs can leak, and an operational surface to keep alive — the opposite of "runs anywhere, trusts no one." The whole appeal is that there is nothing to run.
- **Compile the actual Rust/TS generator to WASM and run it in-page.** Attractive for true single-source parity, but the generator's file I/O and template-walking assume a filesystem; shimming that into the browser is more code than the port, for a tool whose output is a handful of small text files. Revisit if the template set grows an order of magnitude.
- **Vanilla JS, zero framework, single HTML file.** Smallest possible bundle, but the live file tree + two composable modes are stateful enough that hand-rolled DOM would cost more than it saves and would be harder to test. React + a typed generator core earns its weight.
- **No web UI; lean on an asciinema demo instead.** Keeps the surface small but does nothing for the Claude-skill and mobile populations, who cannot act on a terminal recording.

## Test Contract

For this decision to be considered shipped:

- **Unit (generator core).** `render`, `validateHarnessName`, the case helpers, the artifact builders, and `buildScaffold` are covered: every host emits its adapter file; selected agents emit one TS file each plus an index; `package.json` and `.claude/settings.json` parse as JSON and carry the harness name; `CLAUDE.md` contains no unresolved `{{vars}}`; identical inputs are byte-deterministic. (27 tests, `src/generator/__tests__/`.)
- **E2E (real browser, desktop + mobile).** Playwright drives the built app on a Desktop-Chrome and a Pixel viewport: page loads with **zero console errors**; the live preview updates when the name and hosts change; an invalid name disables download and surfaces the reason; the full-harness zip and the single-artifact `.md` both actually download with the expected filenames. (`e2e/generator.spec.ts`.)
- **The e2e suite runs against `vite preview` of the production build**, so the bytes under test are the bytes that deploy.

## References

- ruflo goal UI — the precedent on-ramp: https://goal.ruv.io
- ADR-003 — generator architecture (the contract this UI must match)
- ADR-004 — host integration model (the per-host file shapes)
- Anthropic Agent Skills — the `SKILL.md` frontmatter format the artifact mode targets
- JSZip — client-side archive generation: https://stuk.github.io/jszip/
