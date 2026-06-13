---
name: list-templates
description: List the available harness templates and what each one ships with. Use when the user asks "what templates are available", "what verticals does the harness generator support", or "show me what I can scaffold".
---

# list-templates

Lists every harness template `create-agent-harness` can scaffold from.

## Templates today (Iter 2)

| Template | Status | Agents | Skills | MCP servers | Best for |
|---|---|---|---|---|---|
| `minimal` | Iter 2 (this iter) | 0 | 0 | 1 (kernel) | First-time users, learning the system |
| `vertical:trading` | Iter 6 | 5 | 4 | 2 (kernel + market-data) | Trading bots, backtesting |
| `vertical:devops` | Iter 6 | 4 | 6 | 3 (kernel + alerts + runbook) | Incident response, on-call |
| `vertical:legal` | Iter 6 | 3 | 5 | 2 (kernel + citation-search) | Contract review, redline |
| `vertical:support` | Iter 6 | 4 | 4 | 2 (kernel + ticket-routing) | Customer support, escalation |
| `vertical:research` | Iter 6 | 6 | 5 | 3 (kernel + web-search + dossier) | Multi-source research dossiers |
| `eject-from-ruflo` | Iter 4 | — | — | — | Convert an existing ruflo install into your own harness |

## Hosts each template supports

| Template | Claude Code | Codex | pi.dev | Hermes |
|---|---|---|---|---|
| `minimal` | ✅ | ✅ | ✅ | ✅ |
| `vertical:*` | ✅ | ✅ | ✅ | ✅ |
| `eject-from-ruflo` | ✅ | (one-way) | (one-way) | (one-way) |

## Roadmap

- Vertical packs ship as separate npm packages (`@ruflo/vertical-trading`, etc.) so each pack can be owned by a domain expert
- See [ADR-013](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-013-vertical-packs-publishing.md)
