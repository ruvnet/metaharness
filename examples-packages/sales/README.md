# MetaHarness: sales vertical

<!-- ruv-seo:start (ADR-356) -->
MetaHarness example — sales pipeline pod (qualifier, opener, closer) for Claude Code.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/sales` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/sales my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 33
Manifest: ./my-bot/.harness/manifest.json

Sales pod scaffolded into ./my-bot
Next: cd my-bot && npm install && harness doctor
Then: claude -p --plugin-dir my-bot "Run the sales pipeline on lead: <your lead>"
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) — evolve the scaffolded harness against its own tests instead of hand-tuning it.
<!-- ruv-seo:end -->

## Reference

A ready-made multi-agent sales pipeline pod scaffolded onto Claude Code. Spawns three specialized agents — a **qualifier** (lead scoring), an **opener** (first-touch outreach), and a **closer** (negotiation and follow-through) — wired together with shared memory, MCP tooling, and tier-routed model selection. This scaffold gives you a working harness directory you can run, validate, and extend. It does NOT ship a CRM, send live email, or include any contact data — bring your own pipeline source and outbound transport.

## Quickstart

```bash
npx @metaharness/sales@latest my-bot
cd my-bot && npm install && harness doctor
```

That gives you a populated harness directory, installed dependencies, and a doctor report telling you which MCP servers / API keys are still missing.

## What you get

- `agents/qualifier.md` — lead-scoring + ICP-fit agent. **Tier: haiku** (fast, cheap, runs per-lead).
- `agents/opener.md` — first-touch message drafter, personalization, A/B variants. **Tier: sonnet** (judgement, tone).
- `agents/closer.md` — objection handling, negotiation, multi-thread follow-up. **Tier: opus** (deep reasoning).
- `.claude/settings.json` — pre-wired hooks (pre-task routing, post-task pattern training, session-start memory restore).
- `mcp/` — MCP server stubs for CRM, email, and calendar (stdio transport, swap in your provider).
- `prompts/pipeline.md` — the orchestration prompt that runs qualifier → opener → closer with SendMessage handoff.
- `harness.config.json` — tier routing rules, budgets per agent, and shared memory namespace `sales-pod`.

## Advanced

Verify the install is healthy:

```bash
$ harness doctor
checking node          ok  v20.11.0
checking claude-code   ok  found in PATH
checking mcp servers   warn  crm: no API key set (CRM_API_KEY)
checking agents        ok  3 agents loaded (qualifier, opener, closer)
checking settings.json ok  hooks valid
```

Validate the harness manifest before shipping:

```bash
$ harness validate
manifest    ok
agents      ok  (3/3 frontmatter valid)
mcp         ok  (3/3 schemas valid)
routing     ok  (tier rules cover all agents)
```

Run the pod headlessly against one lead, scoped to your scaffold's plugin dir:

```bash
$ claude -p --plugin-dir my-bot \
    "Run the sales pipeline on lead: Jane Doe, VP Eng at Acme, 200 employees"
[qualifier→haiku]  ICP fit: 0.82  intent: warm  → handoff to opener
[opener→sonnet]    Drafted 2 variants, selected B (Jane's recent OSS commit)
[closer→opus]      Standing by for reply
```

## FAQ

**Does this send real emails?**
No. The `mcp/email` stub returns the drafted message and exits. Swap in a real SMTP / Resend / SendGrid MCP server to actually transmit.

**Can I run it without API keys?**
`harness doctor` will run and the qualifier (haiku) works on offline test fixtures, but the opener and closer call Anthropic — you need `ANTHROPIC_API_KEY` set for end-to-end runs.

**How do I change which model each agent uses?**
Edit `harness.config.json` → `routing.tiers`. Each agent name maps to `haiku`, `sonnet`, or `opus`. The pre-task hook reads this and overrides at dispatch time.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/e9cf34f47cf78308196a6e65c4a35322
