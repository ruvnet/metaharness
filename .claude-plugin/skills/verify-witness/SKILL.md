---
name: verify-witness
description: Verify the Ed25519 witness manifest of a scaffolded harness. Fast yes/no signature check that proves the publisher signed this exact file set — separate from the full release-readiness umbrella in validate-harness.
---

# verify-witness

> Codex skill: Ed25519 witness manifest verification for a scaffolded harness.

## What it does

Reads `.harness/witness.json`, validates the Ed25519 signature against the embedded public key, and reports `VALID` / `INVALID` with a one-line reason.

Distinct from [`validate-harness`](../validate-harness/):
- `validate-harness` is the **umbrella** — doctor + verify + path-guard + mcp + secrets
- `verify-witness` is **only** the signature check — fast yes/no for CI / federation handshakes / multi-signer workflows

## Usage from Codex

```
/verify-witness
/verify-witness path=./my-harness
/verify-witness path=./my-harness strict=false
```

## Equivalent CLI

```bash
harness verify ./my-harness
```

## Why it's separate from validate-harness

When two harnesses federate (iter 9), they need to confirm each other's witness signatures BEFORE doing the full release-readiness check. Splitting this surface lets federation peers run a fast signature handshake without paying for the full validate sweep.

Also: CI workflows that only care about signature integrity (e.g. mirroring a published harness to a private registry) can call this skill instead of the heavier umbrella.

## What's checked

| Check | Detail |
|-------|--------|
| File present | `.harness/witness.json` exists |
| Manifest shape | All required fields (harness, version, entries, public_key, signature) |
| Signature | Ed25519 verify against the embedded public key |
| Strict mode | If `strict=true` and no witness, exit non-zero. If `false`, soft-skip with PASS |

Exit 0 = signature VALID. Exit 1 = INVALID / missing (strict mode).
