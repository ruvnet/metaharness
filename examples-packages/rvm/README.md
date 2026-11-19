# MetaHarness × RVM deployment-target partition

<!-- ruv-seo:start (ADR-356) -->
![@metaharness/rvm flow: npx @metaharness/rvm my-bot scaffolds the example files and the .harness manifest, then harness doctor reports HEALTHY](https://raw.githubusercontent.com/ruvnet/metaharness/main/docs/assets/readme/example-scaffold.svg)

MetaHarness example — minimal agent harness pre-wired for the RVM deployment-target partition.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/rvm` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/rvm my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 15
Manifest: ./my-bot/.harness/manifest.json

Next steps:
  cd my-bot && npm install
  harness doctor   # verify the rvm partition is wired correctly
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/host-rvm`](https://www.npmjs.com/package/@metaharness/host-rvm) — the adapter that writes this host's config, if you want to generate it from your own code.
<!-- ruv-seo:end -->

## Reference

> ⚠️ **Illustrative output.** Transcripts and validation/run output shown in this README are
> representative examples, not captured from a specific run — actual output depends on your
> environment, models, and inputs. Run the commands to see real results.

A minimal, opinionated agent-harness scaffold pre-configured for the RVM deployment-target partition. This scaffold gives you a working `claude -p`-style harness on disk in seconds: agents folder, MCP server wiring, settings.json with the RVM host conventions baked in, and a `harness doctor` health-check pass. It is intentionally minimal — it does NOT ship a vertical multi-agent template (no pre-built researcher/coder/tester crew), and it does NOT install or configure your underlying RVM runtime. Bring your own agents, bring your own runtime; this just gets the harness shape right.

## Quickstart

```bash
npx @metaharness/rvm@latest my-bot
cd my-bot && npm install && harness doctor
```

If `harness doctor` returns green, you are ready to drop agents into `agents/` and run them.

## What you get

- `settings.json` — harness configuration pre-set with the `rvm` host partition (deployment-target conventions, path layout, permission defaults).
- `agents/` — empty agent directory with the canonical layout the harness expects (one folder per agent, `agent.json` + prompt files).
- `mcp.json` — MCP server registration stub wired against the RVM host transport defaults.
- `.harness/` — local state directory (gitignored) for session cache, doctor reports, and routing logs.
- `package.json` — `harness` CLI on the path via `npx`, plus a `doctor` and `validate` npm script.
- `README.md` — project-local readme stub you can overwrite.
- `.gitignore` — pre-populated with `.harness/`, `node_modules/`, and the RVM host's local artifact paths.

## Advanced

Run the harness health check — verifies node version, settings.json schema, MCP server reachability, and host partition match:

```bash
$ harness doctor
[harness] node 20.x          ok
[harness] settings.json      ok (host=rvm, template=minimal)
[harness] mcp.json           ok (1 server registered)
[harness] agents/            ok (0 agents — add one to start)
[harness] rvm partition      ok
```

Validate just the config without touching the network:

```bash
$ harness validate
settings.json: valid
mcp.json: valid
agents: 0 (warning: no agents defined)
```

Run a one-shot prompt against the scaffold using Claude Code's plugin-dir mode (the harness is loadable as a plugin directory):

```bash
$ claude -p --plugin-dir my-bot "list the agents wired into this harness"
```

To re-scaffold over an existing directory (destructive — pass `--force` only if you mean it):

```bash
npx --yes metaharness@latest my-bot --template minimal --host rvm --force
```

## FAQ

**Q: Do I need RVM installed before running this?**
A: No. The scaffold only writes config files and directory structure that follow the RVM host partition conventions. You install/configure the actual RVM runtime when you are ready to deploy.

**Q: Why is the `agents/` directory empty?**
A: This is the `minimal` template — the point is to give you a clean harness shape, not opinions about which agents to run. If you want a pre-built multi-agent crew, look at the vertical templates instead of the minimal one.

**Q: Can I switch the host later without re-scaffolding?**
A: Edit `settings.json` and change the `host` field, then run `harness doctor`. If the partition layout differs, doctor will tell you which paths to move. For non-trivial host switches, re-scaffolding into a fresh directory is usually cleaner.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/28353c033434e68f2c853546c0f99963
