# MetaHarness × pi.dev AGENTS.md harness

<!-- ruv-seo:start (ADR-356) -->
![@metaharness/pi-dev flow: npx @metaharness/pi-dev my-bot scaffolds the example files and the .harness manifest, then harness doctor reports HEALTHY](https://raw.githubusercontent.com/ruvnet/metaharness/main/docs/assets/readme/example-scaffold.svg)

MetaHarness example — pi.dev AGENTS.md harness with a minimal scaffold ready for pi.dev agents.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/pi-dev` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/pi-dev my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 16
Manifest: ./my-bot/.harness/manifest.json

Scaffolded pi.dev harness in ./my-bot
Next: cd my-bot && npm install
Then: harness doctor
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/host-pi-dev`](https://www.npmjs.com/package/@metaharness/host-pi-dev) — the adapter that writes this host's config, if you want to generate it from your own code.
<!-- ruv-seo:end -->

## Reference

> ⚠️ **Illustrative output.** Transcripts and validation/run output shown in this README are
> representative examples, not captured from a specific run — actual output depends on your
> environment, models, and inputs. Run the commands to see real results.

A one-shot scaffold that drops a pi.dev-ready agent harness into a new folder. It wires up the `AGENTS.md` contract that pi.dev workers read on startup, ships a minimal template (no opinionated multi-agent vertical), and leaves you with a clean working directory you can commit immediately. This is for engineers who already know they want pi.dev as their host runtime and just want the boilerplate done. It does NOT include domain-specific agents, evaluation harnesses, or pre-baked workflows — pick a vertical package if you want that.

## Quickstart

```bash
npx @metaharness/pi-dev@latest my-bot
cd my-bot
npm install
harness doctor
```

`harness doctor` verifies that your `AGENTS.md`, host config, and MCP wiring all parse and resolve. If it prints green, you can hand the directory to pi.dev and start a session.

## What you get

- `AGENTS.md` — the canonical contract pi.dev agents read on boot (rules, tools, file boundaries).
- `.pi/config.json` — host-specific config for pi.dev (model defaults, sandbox policy, working dir).
- `harness.config.json` — metaharness-level config so `harness doctor` / `harness validate` know your layout.
- `mcp.json` — empty but valid MCP server registry; add servers as you need them.
- `agents/` — one starter agent stub (`agents/main.md`) you can rename or duplicate.
- `scripts/` — `doctor.mjs` and `validate.mjs` shims that defer to the `harness` CLI.
- `.gitignore`, `package.json`, `README.md` — sane defaults, no lockfile churn.

## Advanced

Validate the AGENTS.md contract and host config without running an agent:

```bash
$ harness doctor
[doctor] AGENTS.md           OK
[doctor] .pi/config.json     OK
[doctor] mcp.json            OK (0 servers registered)
[doctor] harness.config.json OK
ready.
```

Strict-validate every referenced file path and tool name:

```bash
$ harness validate --strict
[validate] resolving 1 agent...
[validate] agents/main.md: tools=[Read, Write, Bash] all resolvable
[validate] no dangling references
ok.
```

Dry-run a pi.dev session against the local scaffold without leaving your shell:

```bash
$ pi-dev run --plugin-dir . --dry-run
[pi-dev] loaded AGENTS.md (1 agent)
[pi-dev] sandbox: workspace-write
[pi-dev] would start: agents/main.md
```

## FAQ

**Q: Do I have to use pi.dev to run this?**
A: No — the `AGENTS.md` file is portable. Other AGENTS.md-aware hosts (Codex, Cursor agents, etc.) will read the same contract. The `.pi/config.json` is the only pi.dev-specific piece, and it's ignored by other hosts.

**Q: Where do I add my own agents?**
A: Drop new markdown files into `agents/` and reference them from `AGENTS.md`. Run `harness validate` to confirm the references resolve before committing.

**Q: Why does this ship `mcp.json` with zero servers?**
A: So `harness doctor` has a real file to validate against. Add MCP servers with `harness mcp add <name>` or by editing the file directly — both are supported.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/ec3c2bb303ba99d83dc5cb36306d6380
