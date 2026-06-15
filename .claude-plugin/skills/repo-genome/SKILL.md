---
name: repo-genome
description: 7-section readiness scorecard for a LOCAL repo. Reports repo type + agent topology + MCP risk + test confidence + release readiness + recommended harness plan + scorecard. Exit 0 ready, 1 needs-work, 2 blocked. --json for the 6-field scorecard, --bundle for the ADR-031 schema-1 envelope.
---

# repo-genome

> Codex skill: 7-section readiness scorecard for a local repo — the
> ADR-031 Bundle JSON Pattern surfaced through Codex (iter 110 → 114).

## What it does

Answers a different question than `analyze-repo`:

- **analyze-repo** — "which archetype / template / agents fit this repo?"
- **repo-genome** — "is this repo READY for that harness, and what's the risk?"

Produces a 7-section report:

1. **Repo profile** — type, languages, build/test commands, ci presence
2. **Agent topology** — recommended roles (maintainer / tester / security / release)
3. **MCP risk model** — surface + numeric risk + policy posture
4. **Test confidence** — how strong are the test signals
5. **Release readiness** — buildable / testable / ci-wired
6. **Recommended harness plan** — template, archetype, hosts, agents, skills
7. **Scorecard** — risk_score, publish_readiness, test_confidence

LOCAL-only, deterministic, never executes repo code. Same invariant as
`analyze-repo` (inherited via the shared inventory/profile pipeline).

| Verdict | Exit | Meaning |
|---|---|---|
| `ready` | 0 | publish_readiness >= 0.75 && risk_score < 0.35 |
| `needs-work` | 1 | somewhere in the middle |
| `blocked` | 2 | risk_score >= 0.7 |

## Usage from Codex

```
/repo-genome path=./my-repo
/repo-genome path=./my-repo bundle=true
/repo-genome path=./my-repo out=./harness-genome.json
```

## Equivalent CLI

```bash
harness genome ./my-repo                          # text report
harness genome ./my-repo --json                   # 6-field scorecard JSON
harness genome ./my-repo --bundle                 # ADR-031 schema-1 envelope
harness genome ./my-repo --out harness-genome.json # write scorecard to file
```

## Sample 6-field output (--json)

```json
{
  "repo_type": "rust_node_polyglot_mcp_ci",
  "agent_topology": ["maintainer", "tester", "security", "release"],
  "risk_score": 0.31,
  "mcp_surface": "local_default_deny",
  "test_confidence": 0.86,
  "publish_readiness": 0.78
}
```

## When to use it

- Before scaffolding a harness — run genome first, decide whether the
  repo is ready or needs cleanup
- In CI on incoming PRs — post the genome report as a check; alert when
  risk_score crosses a threshold
- For support tickets — `--bundle` emits the full readiness snapshot
  sanitised for safe sharing

## Related skills

- `repo-analyze` (iter — proposed) — the archetype-and-plan recommendation
- `compare-harnesses` (iter 109) — diff two scaffolded harnesses
- `diag-harness` (iter 70) — kernel-version skew check
- `score-harness` (iter 114) — post-scaffold harness scorecard

## See also

- [ADR-030 Discovery Loop](../../../docs/adrs/ADR-030-discovery-loop.md)
- [ADR-031 Bundle JSON Pattern](../../../docs/adrs/ADR-031-bundle-json-pattern.md)
