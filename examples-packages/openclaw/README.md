# MetaHarness × OpenClaw .openclaw/ config

<!-- ruv-seo:start (ADR-356) -->
![@metaharness/openclaw flow: npx @metaharness/openclaw my-bot scaffolds the example files and the .harness manifest, then harness doctor reports HEALTHY](https://raw.githubusercontent.com/ruvnet/metaharness/main/docs/assets/readme/example-scaffold.svg)

MetaHarness example — minimal scaffold wired to OpenClaw's .openclaw/ config.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/openclaw` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/openclaw my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 15
Manifest: ./my-bot/.harness/manifest.json

Next steps:
  1. cd my-bot
  2. npm install
  3. harness doctor   # verify the .openclaw/ config
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/host-openclaw`](https://www.npmjs.com/package/@metaharness/host-openclaw) — the adapter that writes this host's config, if you want to generate it from your own code.
<!-- ruv-seo:end -->

## Reference

> ⚠️ **Illustrative output.** Transcripts and validation/run output shown in this README are
> representative examples, not captured from a specific run — actual output depends on your
> environment, models, and inputs. Run the commands to see real results.

A minimal MetaHarness scaffold pre-wired for [OpenClaw](https://github.com/openclaw), the open-source AI coding host that reads its configuration from a `.openclaw/` directory. Run one command and you get a working harness folder with the right config file layout, a starter agent, and the doctor/validate tooling that ships with MetaHarness. This is for developers who want to bootstrap an OpenClaw-compatible project without copy-pasting a config tree from another repo. It does NOT install OpenClaw itself, ship a model, or run any agent for you — it scaffolds the static files you need so `openclaw` (or any OpenClaw-compatible runner) finds a valid configuration on first launch.

## Quickstart

```bash
npx @metaharness/openclaw@latest my-bot
cd my-bot
npm install
harness doctor
```

`harness doctor` walks the generated tree, confirms the `.openclaw/` config is present and parseable, and reports anything missing before you point a runtime at it.

## What you get

- `.openclaw/config.json` — the host-specific manifest OpenClaw looks for on startup
- `.openclaw/agents/` — one starter agent definition you can rename, duplicate, or delete
- `harness.config.mjs` — the MetaHarness root config that ties templates, hosts, and validators together
- `package.json` — pinned `harness` CLI plus `doctor`, `validate`, and `dev` scripts
- `README.md` — a short orientation for whoever opens the repo next
- `.gitignore` — sensible defaults so you don't commit `node_modules/` or local secret files

## Advanced

Run the built-in diagnostics:

```bash
harness doctor
# ✓ .openclaw/config.json found
# ✓ 1 agent definition discovered
# ✓ harness.config.mjs parses
# ✓ host=openclaw template=minimal
```

Validate the config schema without running anything:

```bash
harness validate
# .openclaw/config.json   ok
# .openclaw/agents/*.json  ok
# 0 errors, 0 warnings
```

Point another tool at the same folder (any Claude-compatible CLI works):

```bash
claude -p --plugin-dir ./my-bot "list the agents in this project"
```

Re-scaffold in place after editing the template (overwrites the harness skeleton, leaves your agents alone):

```bash
npx metaharness@latest my-bot --template minimal --host openclaw --force
```

## FAQ

**Q: Does this install OpenClaw?**
A: No. It only writes the `.openclaw/` configuration tree that an OpenClaw runtime expects to find. Install OpenClaw separately following its own docs.

**Q: Can I use this with Claude Code, Codex, or another host?**
A: This scaffold is specifically wired for the OpenClaw host config layout. For other hosts, run `npx metaharness@latest my-bot --host <name>` directly, or use one of the sibling `@metaharness/*` example packages.

**Q: How do I add a second agent?**
A: Copy `.openclaw/agents/<starter>.json`, rename it, edit the `name` and `prompt` fields, then run `harness validate` to confirm the schema still passes.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/d88608ce148db9ca410243d35997d38a
