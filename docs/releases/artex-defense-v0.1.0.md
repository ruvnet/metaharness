# @metaharness/artex-defense 0.1.0: first public release

Package: `@metaharness/artex-defense@0.1.0` only.

The offline defensive evidence replay from #512, previously a private workspace, published as a standalone package.

## What it does

- Imports an ARTEX findings CSV (v0.6.0 layout and the reviewed source layout) or JSON identity and edge telemetry, bound to a tenant, case and SHA-256 by a scoped manifest.
- Replays a baseline and a candidate policy over the same events, simulates a session quarantine (never enforced), and commits both to a hash-chained MetaHarness receipt.
- `verify` recomputes everything from the original evidence and accepts only the exact report bytes against an independently retained tail hash.

## Packaging

- CLI `artex-defense` and an ESM entry (`index.mjs`, with `index.d.ts`) exporting the importer, both policies, the simulator, the receipt functions and `dispatch(command, args)`, which returns `{code, lines, errors}` without exiting. `redblue defense` uses it.
- The bin compares real paths, so it runs through npm's `node_modules/.bin` symlink. Covered by `cli.test.mjs`.
- `files` allowlist: sources, fixtures, README and LICENSE. Tests and the profiler are not shipped. One dependency, `@metaharness/harness@0.2.1`.
- The packed tarball was installed into an empty directory and run on Node 20.20.2 and 22.23.2: `replay` and `verify` on both fixtures, rejection of a wrong tail hash and refusal to overwrite a report. Both versions printed the same receipt tail hash.
- CI now runs this package's `node --test` suite (26 tests).
