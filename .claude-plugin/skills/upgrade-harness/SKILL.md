---
name: upgrade-harness
description: Drift detection + apply for a scaffolded harness. Re-renders the template with the same vars, computes added/removed/changed file plan, and applies with Git-style conflict markers or .rej files. Default is dry-run.
---

# upgrade-harness

> Codex skill: drift detection + apply for a scaffolded harness.

## What it does

Re-renders the template that produced the harness against the current generator version, using the same `vars` the original scaffold used. Computes a 3-bucket plan:

| Bucket | Meaning |
|---|---|
| **added** | upstream template now has files the harness doesn't |
| **removed** | upstream template no longer has files the harness does |
| **changed** | upstream and harness differ; sub-classified `clean` vs `conflict` |

A **clean** change means the harness's version equals the original generation — apply safely. A **conflict** means the user edited the file post-scaffold; the apply step writes either Git-style inline markers or a `.rej` sidecar for manual merge.

## Usage from Codex

```
/upgrade-harness                                       # dry-run on cwd
/upgrade-harness path=./my-harness
/upgrade-harness path=./my-harness apply=true
/upgrade-harness path=./my-harness apply=true conflict=rej
```

## Equivalent CLI

```bash
harness upgrade ./my-harness                           # dry-run
harness upgrade ./my-harness --apply                   # apply, inline conflicts
harness upgrade ./my-harness --apply --conflict=rej    # apply, .rej sidecars
```

## Lifecycle position

```
scaffold (create-agent-harness)
    ↓
 edit (you)
    ↓
 upgrade (this skill)   <- catches up to the latest template
    ↓
 sign / verify / publish
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No drift OR clean apply (no conflicts) |
| 1 | Unresolved conflicts after apply, OR not a generated harness, OR template missing |
| 2 | Bad `--conflict=` value |

CI workflows can gate on exit 1 to flag unresolved conflicts.
