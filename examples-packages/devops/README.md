# MetaHarness: devops vertical

<!-- ruv-seo:start (ADR-356) -->
![@metaharness/devops flow: npx @metaharness/devops my-bot scaffolds the example files and the .harness manifest, then harness doctor reports HEALTHY](https://raw.githubusercontent.com/ruvnet/metaharness/main/docs/assets/readme/example-scaffold.svg)

MetaHarness example — Claude Code incident-response vertical with responder, runbook-runner, escalator, postmortem agents.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/devops` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/devops my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 26
Manifest: ./my-bot/.harness/manifest.json

Next: cd my-bot && npm install
Then: npm run doctor
Run:  claude -p --plugin-dir my-bot "page: <your incident here>"
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) — evolve the scaffolded harness against its own tests instead of hand-tuning it.
<!-- ruv-seo:end -->

## Reference

> ⚠️ **Illustrative output.** Transcripts and validation/run output shown in this README are
> representative examples, not captured from a specific run — actual output depends on your
> environment, models, and inputs. Run the commands to see real results.

A ready-made multi-agent scaffold for incident response on top of Claude Code. It provisions four specialized agents — `responder`, `runbook-runner`, `escalator`, and `postmortem` — wired together with tiered model routing, project-scoped settings, and a `harness doctor` health check. Use it to bootstrap an on-call assistant that triages alerts, executes runbooks, escalates when stuck, and writes the postmortem afterward.

This scaffold is for SREs, platform engineers, and on-call developers who want a working incident-response harness in one command instead of assembling agents, prompts, and config by hand. It is NOT a hosted service, an alerting system, or a replacement for PagerDuty / Opsgenie / Grafana OnCall — it is the Claude Code layer that sits next to those tools.

## Quickstart

```bash
npx @metaharness/devops@latest my-bot
cd my-bot && npm install && npm run doctor
```

Then launch Claude Code against the scaffold:

```bash
claude -p --plugin-dir my-bot "page: api-gateway 5xx spike, last 10m"
```

## What you get

- `agents/responder.md` — first-touch triage agent (tier: **sonnet**). Reads the alert, pulls recent logs/metrics, proposes hypotheses.
- `agents/runbook-runner.md` — executes documented runbooks step-by-step (tier: **haiku**). Cheap, deterministic, fast.
- `agents/escalator.md` — decides when human escalation is warranted and drafts the page (tier: **sonnet**).
- `agents/postmortem.md` — writes a blameless postmortem from the incident transcript (tier: **opus**).
- `.claude/settings.json` — project-scoped Claude Code config with allow-listed tools (Read, Grep, Glob, Bash for read-only commands).
- `mcp.json` — pre-wired MCP server stubs for log search and metrics queries; edit to point at your stack.
- `runbooks/` — example runbook templates the `runbook-runner` agent consumes.
- `package.json` with a `harness` bin shim so `npm run doctor` and `npm run validate` work out of the box.

## Advanced

Run the bundled doctor to verify the scaffold is healthy:

```bash
$ npm run doctor
[harness] node: v20.11.1  ok
[harness] claude code: detected
[harness] agents: 4 found (responder, runbook-runner, escalator, postmortem)
[harness] mcp.json: 2 servers configured
[harness] settings.json: valid
ok
```

Validate the agent frontmatter and tier assignments:

```bash
$ npm run validate
[harness] agents/responder.md      tier=sonnet  tools=Read,Grep,Bash  ok
[harness] agents/runbook-runner.md tier=haiku   tools=Read,Bash       ok
[harness] agents/escalator.md      tier=sonnet  tools=Read,WebFetch   ok
[harness] agents/postmortem.md     tier=opus    tools=Read,Write      ok
ok
```

Drive the harness headlessly for CI or webhook integrations:

```bash
claude -p --plugin-dir my-bot --output-format json \
  "incident: redis OOMKilled in prod-us-east-1, alert id INC-4421"
```

Pipe a recent alert payload from your incident tool straight into the responder:

```bash
cat alert.json | claude -p --plugin-dir my-bot --append-system-prompt "You are the on-call responder. Start with the responder agent."
```

## FAQ

**Q: Does this replace PagerDuty / Opsgenie?**
A: No. It plugs into them. The `escalator` agent drafts the page; your existing tool delivers it. Wire the MCP server in `mcp.json` to your incident platform's API.

**Q: Can I change which model each agent uses?**
A: Yes. Edit the `model:` field in the YAML frontmatter of each `agents/*.md` file. The defaults (haiku for runbook execution, sonnet for triage, opus for postmortems) follow the 3-tier cost/latency pattern but every choice is a one-line override.

**Q: How do I add my own runbook?**
A: Drop a markdown file into `runbooks/`. The `runbook-runner` agent discovers them by glob and matches against the incident description. No registration step.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/7c2975652c9be393536a71cdafc358f3
