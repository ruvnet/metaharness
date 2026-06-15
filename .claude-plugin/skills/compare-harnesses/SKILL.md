---
name: compare-harnesses
description: Diff two scaffolded harnesses (ADR-031). Reports manifest meta drift + host list + per-file fingerprint changes (added/removed/changed). Exits 0 IDENTICAL, 1 DRIFT, 2 missing manifest. Use --bundle for the ADR-031 schema-1 JSON envelope.
---

# compare-harnesses

> Codex skill: diff two scaffolded harnesses — the ADR-031 Bundle JSON
> Pattern surfaced through Codex (iter 105 → iter 109).

## What it does

Two-harness diff. Useful when you've forked an upstream template, when a
support ticket says "mine and theirs scaffolded different things", or when a
CI script wants a byte-equality check between a candidate scaffold and a
known-good baseline.

Reports three sections:

1. **Manifest meta** — same name? same kernel? same surface?
2. **Hosts** — which host adapters each side ships (`claude-code` /
   `codex` / `pi-dev` / `hermes` / `openclaw` / `rvm`)
3. **Files** — added / removed / changed (per-file SHA-256 fingerprints;
   the cheapest possible byte-equality test)

| Verdict | Exit | Meaning |
|---|---|---|
| `IDENTICAL` | 0 | meta + hosts + every file fingerprint matches |
| `DRIFT` | 1 | at least one of meta / hosts / files differs |
| `no-manifest-in-a` | 2 | `a/.harness/manifest.json` missing |
| `no-manifest-in-b` | 2 | `b/.harness/manifest.json` missing |
| `no-manifest-in-either` | 2 | both sides missing manifest |

## Usage from Codex

```
/compare-harnesses a=./my-fork b=./upstream
/compare-harnesses a=./my-fork b=./upstream bundle=true
```

## Equivalent CLI

```bash
harness compare ./my-fork ./upstream                  # text output
harness compare ./my-fork ./upstream --bundle         # ADR-031 schema-1 JSON
```

The `--bundle` form (ADR-031) emits a schema-1 JSON envelope so CI scripts
can json-parse the verdict without re-parsing human text. The envelope
shape is shared with `harness diag --bundle`, `harness export-config`, and
`harness audit --bundle`:

```json
{
  "schema": 1,
  "generatedAt": "2026-06-15T...",
  "a": "/path/to/a",
  "b": "/path/to/b",
  "meta": { "sameKernel": true, "sameSurface": true, "sameName": false },
  "hosts": { "a": ["claude-code"], "b": ["claude-code", "codex"], "verdict": "PASS" | "FAIL" },
  "files": { "added": [...], "removed": [...], "changed": [...] },
  "identical": false,
  "exitCode": 1
}
```

Errors are bundle-formed too (`{ "schema": 1, "error": "no-manifest-in-a" }`),
so a CI script never has to dual-parse text + JSON. Object keys matching
`secret|token|key|password|passphrase` are redacted via the canonical
ADR-031 sanitisation regex before emission — safe to paste into a public
GitHub issue.

## Sample output (text mode)

```
harness compare — diffing /tmp/a /tmp/b

  name:              A=cmp-a   B=cmp-b   FAIL
  kernel:            A=0.1.0   B=0.1.0   PASS
  surface:           A=cli     B=cli     PASS
  hosts:             A=[claude-code] B=[claude-code,codex] FAIL

  added:             3 files
    + src/agents/codex-tester.ts
    + src/agents/codex-reviewer.ts
    + .codex/config.toml
  removed:           0 files
  changed:           1 file
    ~ .harness/manifest.json

DRIFT (exit 1)
```

## When to use it

- You forked the project's upstream template, edited it, and want to know
  exactly what diverged before sending a PR upstream.
- A user files a "this doesn't work" bug; you run `harness compare
  their-zip yours-zip --bundle > diff.json` and attach the bundle to the
  issue.
- CI is the canonical place: a nightly job runs `compare` between today's
  scaffold output and a frozen baseline, fails the run on `DRIFT`.

## Related skills

- `diag-harness` — single-harness kernel-version skew check (iter 66)
- `validate-harness` — release-readiness umbrella (iter 20)
- `verify-witness` — Ed25519 witness signature verification (iter 8)

## See also

- [ADR-030 — Discovery Loop](../../../docs/adrs/ADR-030-discovery-loop.md) —
  why new subcommands propagate to codex skills.
- [ADR-031 — Bundle JSON Pattern](../../../docs/adrs/ADR-031-bundle-json-pattern.md) —
  the envelope shape this skill's `--bundle` mode conforms to.
