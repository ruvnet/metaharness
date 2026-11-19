# metaharness 0.4.22: package metadata, README and fixes

Package: `metaharness@0.4.22` only.

## Fixes

- `harness doctor` now accepts a fresh scaffold for every host. Before this release, a harness made with `--host github-actions`, `copilot`, `opencode` or `prime-agent` failed the "at least one host artifact present" check straight out of `metaharness new`. The check now also recognises `.github/workflows` with `.github/actions`, `.vscode/mcp.json` or `.github/copilot-instructions.md`, `.opencode/opencode.json`, and `.prime/` or `install-prime-agent.md`. Covered by `__tests__/integration/doctor-every-host.test.ts`, which scaffolds every host in `HOSTS` and requires a clean doctor run.
- README: a "Ready-made scaffolds" list linking every `@metaharness/*` example package, and a link to the tested GitHub Actions evaluation recipe.

## Metadata (ADR-356)

- `homepage` is `https://ruv.io`; `repository` points at `https://github.com/ruvnet/metaharness.git` with `directory: packages/create-agent-harness`; `bugs` points at the metaharness issue tracker.
- Description rewritten to state the package's one job in 192 characters; 20 keywords, each tied to a real feature.
- README opens with the one job, supported environments, a quickstart whose expected output was captured from a clean install of the packed tarball, and one link to the next package. All earlier README content is kept under "Reference".

No API changes.
