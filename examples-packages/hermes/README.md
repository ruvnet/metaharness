# MetaHarness × Hermes cli-config harness

<!-- ruv-seo:start (ADR-356) -->
MetaHarness example — Hermes cli-config harness scaffold for AI agents.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/hermes` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/hermes my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 17
Manifest: ./my-bot/.harness/manifest.json

Scaffolded my-bot with the Hermes minimal harness.
Next: cd my-bot && npm install
Then: npm run doctor
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/host-hermes`](https://www.npmjs.com/package/@metaharness/host-hermes) — the adapter that writes this host's config, if you want to generate it from your own code.
<!-- ruv-seo:end -->

## Reference

> ⚠️ **Illustrative output.** Transcripts and validation/run output shown in this README are
> representative examples, not captured from a specific run — actual output depends on your
> environment, models, and inputs. Run the commands to see real results.

A one-shot scaffolder that drops a minimal, working Hermes-integrated agent harness into a fresh directory. It wires up the host-specific config file Hermes expects, a baseline `harness.json`, and the bare-minimum agent + MCP plumbing so you can run `harness doctor` and get a green check in under a minute. It is intentionally NOT a multi-agent template, a vertical solution, or an opinionated framework — it is the smallest viable starting point for building a Hermes-driven CLI agent.

## Quickstart

```bash
npx @metaharness/hermes@latest my-bot
cd my-bot && npm install && npm run doctor
```

That sequence scaffolds the project, installs dependencies, and runs the harness self-check. If `doctor` passes, you have a working Hermes harness.

## What you get

- `harness.json` — the canonical MetaHarness manifest (host: `hermes`, template: `minimal`).
- `hermes.config.json` — host-specific Hermes CLI configuration with default model + transport settings.
- `agents/` — one starter agent definition you can copy and rename.
- `mcp/` — placeholder `servers.json` listing the default MCP servers the harness expects.
- `.harness/settings.json` — local-only settings (gitignored) for API keys and per-machine overrides.
- `package.json` with `harness`, `harness doctor`, and `harness validate` wired as scripts.
- A `README.md` stub inside the scaffold pointing at the Hermes CLI docs.

## Advanced

Run the built-in health check:

```bash
npm run doctor
```

Expected excerpt:

```
[ok] harness.json valid
[ok] hermes.config.json present
[ok] node >= 20
[ok] mcp/servers.json parseable
```

Validate the manifest against the MetaHarness schema:

```bash
npm run validate
# manifest: ok (host=hermes, template=minimal)
```

Run the scaffold against the Claude Code CLI for a smoke test:

```bash
claude -p --plugin-dir ./my-bot "say hello as my agent"
```

You can also re-scaffold over an existing directory by passing `--force` through:

```bash
npx @metaharness/hermes@latest my-bot --force
```

## FAQ

**Q: Does this install Hermes itself?**
A: No. It scaffolds a project configured to talk to Hermes. Install the Hermes CLI separately following the upstream Hermes docs, then point `hermes.config.json` at your install.

**Q: Can I rename the project after scaffolding?**
A: Yes. Rename the directory and update the `name` field in `package.json` and `harness.json`. Nothing else hard-codes the project name.

**Q: Why is my key not picked up?**
A: Local secrets live in `.harness/settings.json`, which is gitignored. Add `ANTHROPIC_API_KEY` (or the relevant provider key) there, or export it in your shell before running `harness doctor`.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/873383a86723de0d3ef54273e1ff92d1
