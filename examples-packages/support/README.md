# MetaHarness: support vertical

<!-- ruv-seo:start (ADR-356) -->
MetaHarness example — customer-support multi-agent template (triager, KB-searcher, responder, escalator) for Claude Code.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/support` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/support my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 26
Manifest: ./my-bot/.harness/manifest.json

Scaffolded support harness at ./my-bot
Next: cd my-bot && npm install && harness doctor
Then: claude -p --plugin-dir my-bot "Triage ticket: <paste ticket here>"
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) — evolve the scaffolded harness against its own tests instead of hand-tuning it.
<!-- ruv-seo:end -->

## Reference

A ready-made customer-support multi-agent template for Claude Code. Scaffolds a four-agent pipeline — triager, KB-searcher, responder, escalator — wired with tier-routed model selection, shared memory, and the MCP servers a support workflow actually needs. It is opinionated about pipeline shape and agent boundaries; it is not a hosted product, not a ticketing system, and not a CRM. You bring the knowledge base, the inbox, and the escalation channel; the scaffold gives you the agents and the glue.

## Quickstart

```bash
npx @metaharness/support@latest my-bot
cd my-bot && npm install && harness doctor
```

`harness doctor` checks Node, the Claude CLI, MCP server reachability, and the agent files. Fix anything red before sending traffic.

## What you get

- `agents/triager.md` — classifies inbound tickets by intent, urgency, and product area. **Tier: haiku** (cheap, high-volume).
- `agents/kb-searcher.md` — semantic search over your knowledge base via the memory MCP server. **Tier: haiku**.
- `agents/responder.md` — drafts the customer reply grounded in KB hits, handles tone and policy. **Tier: sonnet**.
- `agents/escalator.md` — decides when to hand off to a human, writes the internal handoff note, redacts PII. **Tier: opus** (judgment-heavy, low-volume).
- `mcp.json` — preconfigured MCP servers: memory (KB + conversation state), filesystem (transcripts), and a stub `tickets` server you point at your real ticketing backend.
- `settings.json` — Claude Code permissions allowlist tuned for read-mostly support work plus the write paths the responder and escalator need.
- `CLAUDE.md` — pipeline contract: who messages whom via `SendMessage`, what each agent must hand off, the escalation policy.

## Advanced

Validate the scaffold structure:

```bash
harness validate
# ok agents/triager.md
# ok agents/kb-searcher.md
# ok agents/responder.md
# ok agents/escalator.md
# ok mcp.json
# ok settings.json
```

Run a one-shot ticket through the pipeline headless, no interactive session:

```bash
claude -p --plugin-dir my-bot "Triage and respond to ticket #4821: 'Refund still not received after 10 days'"
# triager  -> intent=refund_status, urgency=high
# kb-searcher -> 3 KB hits (refund SLA, escalation policy, billing contact)
# responder -> drafted reply (412 tokens)
# escalator -> human handoff required: refund > 7 days
```

Swap the KB backend by editing `mcp.json`'s `memory` entry — point it at your existing AgentDB, a Postgres+pgvector store, or any MCP-compatible memory server. The agent prompts use the MCP tool surface, not a hardcoded backend.

Override an agent's tier without editing prompts — set `tier: opus` in the agent's frontmatter and the responder will route through Opus instead of Sonnet on next run.

## FAQ

**Q: Does this connect to Zendesk / Intercom / Front out of the box?**
A: No. The `tickets` MCP server in `mcp.json` is a stub. Replace its `command` with an MCP server that wraps your real ticketing API, or write a thin adapter — the agents only call MCP tools, not vendor SDKs.

**Q: Where does the knowledge base live?**
A: Wherever you point the `memory` MCP server. The default config uses a local AgentDB store at `./data/kb`. Index your KB once with `harness kb ingest <path>` (the scaffold ships the ingest script) and the kb-searcher agent will find it.

**Q: Can I run this without the escalator agent?**
A: Yes. Delete `agents/escalator.md` and remove the escalator handoff line in `CLAUDE.md`. The responder will then be the terminal node and you lose the human-handoff policy — wire one in your ticketing system instead.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/97a386e2c52cf15c6ec6d33386386180
