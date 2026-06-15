---
name: threat-model
description: MCP threat-model artifact for a scaffolded harness. Reports allowed/denied tools, dangerous permissions count, secrets reachability, network/shell/file-write grants, default-deny posture. Verdict: clean (exit 0) / medium (exit 1) / high (exit 2). The 'enterprise gold' artifact for PR + compliance review.
---

# threat-model

> Codex skill: MCP threat-model artifact for PR / compliance review
> (iter 112 → iter 114). User-labelled "enterprise gold."

## What it does

Renders the existing `mcp-scan` findings as a clean threat-model artifact
in the shape a security / compliance reviewer wants to see attached to a
PR:

```
MCP Threat Model

  Allowed tools:         3
  Denied tools:          14
  Dangerous permissions: 0
  Secrets reachable:     no
  Network access:        no
  Shell access:          no
  File write:            no
  Default-deny policy:   yes
  Audit log:             yes

Verdict: clean (exit 0)
```

Same underlying scan as `mcp-scan`, presented as a single-screen artifact.

| Verdict | Exit | Triggers |
|---|---|---|
| `clean` | 0 | no dangerous perms, no secret exposure |
| `medium` | 1 | network OR file-write granted, OR no audit log |
| `high` | 2 | shell granted OR default-deny OFF OR secrets reachable |

The "secrets reachable" heuristic is conservative: true when MCP is in
use AND deny rules don't guard `.env*` AND allow rules include any
`Read(...)` grant.

## Usage from Codex

```
/threat-model path=./my-harness
/threat-model path=./my-harness bundle=true
```

## Equivalent CLI

```bash
harness threat-model ./my-harness                # text artifact
harness threat-model ./my-harness --json         # full envelope
harness threat-model ./my-harness --bundle       # ADR-031 schema-1
harness threat-model ./my-harness --out tm.json  # write to file
```

## When to attach this to a PR

- Adding a new MCP server / tool
- Loosening a permission allow rule
- Pulling in a new dependency that exposes shell/network capabilities
- Any change to `.harness/mcp-policy.json` or `.claude/settings.json`
  permissions

The artifact is small enough to paste verbatim into the PR description.

## Related skills

- `validate-harness` (iter 22) — release-readiness umbrella (includes
  mcp-scan)
- `score-harness` (iter 114) — broader 0-100 scorecard; MCP safety is
  one of its 5 dimensions
- `repo-genome` (iter 114) — pre-scaffold readiness; MCP risk is one of
  its 7 sections

## See also

- ADR-022 — MCP primitive · ADR-030 — Discovery Loop · ADR-031 — Bundle Pattern
