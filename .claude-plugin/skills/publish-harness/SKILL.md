---
name: publish-harness
description: Publish a generated harness to npm — runs the smoke test, signs the witness manifest, and dispatches `npm publish --provenance` from your tagged release.
---

# publish-harness

> Codex skill that runs the full smoke-test → witness-sign → npm publish pipeline for a generated harness.

## What it does

1. Builds the harness with `npm run build`
2. Runs `npm test` to confirm green tests
3. Calls `harness sign` to produce a fresh witness manifest (requires `WITNESS_SIGNING_KEY` env)
4. Confirms `harness verify` accepts the freshly signed manifest
5. Either:
   - `dry_run=true` (default): runs `npm publish --dry-run` and reports tarball stats
   - `dry_run=false`: runs the real `npm publish --provenance --access public`

## Usage from Codex

```
/publish-harness path=./my-harness
/publish-harness path=./my-harness dry_run=false
```

## Equivalent CLI

```bash
cd ./my-harness
npm run build
npm test
harness sign
harness verify
npm publish --provenance --access public
```

## Required env

- `WITNESS_SIGNING_KEY` — 64-hex-char ed25519 seed (fetch from GCP Secret Manager via `harness secrets fetch WITNESS_SIGNING_KEY`)
- `NPM_TOKEN` — npm registry credential (Codex skill assumes the host has it set, or fetches via `harness secrets fetch NPM_TOKEN`)

## See also

- `validate-harness` — release-readiness gate (run this FIRST)
- `harness-secrets` — manage GCP-stored signing/publishing tokens
