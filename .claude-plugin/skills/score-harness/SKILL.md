---
name: score-harness
description: 5-dimension scorecard (0-100, grade A/B/C/F) for a scaffolded harness. Dimensions: Repo understanding (25%), Agent usefulness (25%), MCP safety (20%), Test coverage (15%), Publish readiness (15%). Emits a 6-field badges block (score + mcpRisk + 4 booleans) ready for the harness README. Exit 0 A/B, 1 C, 2 F.
---

# score-harness

> Codex skill: 5-dimension harness scorecard with README-ready badges
> (iter 111 → iter 114).

## What it does

Every generated harness gets a single 0-100 score and a 6-field badge
block. The user roadmap target: **A grade (>=85) without manual edits.**

| Dimension | Weight | Reads |
|---|---|---|
| Repo understanding | 25% | `.harness/manifest.json` (surface + kernel_version + host) |
| Agent usefulness | 25% | `src/agents/*.ts` + `.claude/skills/*` + `.claude/commands/*` counts |
| MCP safety | 20% | `.harness/mcp-policy.json` (default-deny + audit + perm gates) |
| Test coverage | 15% | `__tests__/` + `npm test` + `.github/workflows/` |
| Publish readiness | 15% | `witness.json` + `sbom.json` + `package.json#bin` |

Grade + exit code:

| Grade | Range | Exit |
|---|---|---|
| **A** | 85-100 | 0 — the user's target |
| **B** | 70-84 | 0 |
| **C** | 50-69 | 1 (needs work) |
| **F** | 0-49 | 2 (blocked) |

## Badge block (the 6-field shape)

```json
{
  "score": 87,
  "mcpRisk": "Low",
  "releaseReady": true,
  "testsDetected": true,
  "sbom": true,
  "witnessSigned": true
}
```

`mcpRisk` is one of `None` / `Low` / `Medium` / `High`. Drop this block
into the generated harness README as visible badges — see ADR-030 for the
propagation discipline.

## Usage from Codex

```
/score-harness path=./my-harness
/score-harness path=./my-harness bundle=true
```

## Equivalent CLI

```bash
harness score ./my-harness                # text + bars + dimension breakdown
harness score ./my-harness --json         # 6-field badges JSON
harness score ./my-harness --bundle       # ADR-031 schema-1 envelope
harness score ./my-harness --out badges.json
```

## Related skills

- `validate-harness` (iter 22) — release-readiness umbrella that the
  score subcommand inherits signals from
- `diag-harness` (iter 70) — kernel-version skew (one of the
  Repo-understanding signals)
- `threat-model` (iter 114) — focused MCP threat artifact

## See also

- [ADR-030](../../../docs/adrs/ADR-030-discovery-loop.md) · [ADR-031](../../../docs/adrs/ADR-031-bundle-json-pattern.md)
