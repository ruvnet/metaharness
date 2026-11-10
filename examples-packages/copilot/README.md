# MetaHarness × VSCode/Copilot mcp.json

<!-- ruv-seo:start (ADR-356) -->
![@metaharness/copilot flow: npx @metaharness/copilot my-bot scaffolds the example files and the .harness manifest, then harness doctor reports HEALTHY](https://raw.githubusercontent.com/ruvnet/metaharness/main/docs/assets/readme/example-scaffold.svg)

MetaHarness example — VSCode/Copilot mcp.json scaffold for agentic workflows.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/copilot` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/copilot my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 17
Manifest: ./my-bot/.harness/manifest.json

Next steps:
  cd my-bot && npm install
  harness doctor   # verify VSCode + mcp.json are wired up
  code .           # open in VSCode and enable Copilot MCP servers
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/host-copilot`](https://www.npmjs.com/package/@metaharness/host-copilot) — the adapter that writes this host's config, if you want to generate it from your own code.
<!-- ruv-seo:end -->

## Reference

> ⚠️ **Illustrative output.** Transcripts and validation/run output shown in this README are
> representative examples, not captured from a specific run — actual output depends on your
> environment, models, and inputs. Run the commands to see real results.

A minimal scaffold that wires up GitHub Copilot in VSCode with MCP (Model Context Protocol) servers via `mcp.json`. This is for developers who already use Copilot Chat in VSCode and want to extend it with custom tools, file-system context, and MCP-backed integrations without hand-rolling configuration files. It does NOT ship a custom Copilot model, agent runtime, or replacement for Copilot Chat — it just generates the config layer that VSCode's Copilot reads on startup.

## Quickstart

```bash
npx @metaharness/copilot@latest my-bot
cd my-bot && npm install && harness doctor
```

Then open `my-bot/` in VSCode. Copilot Chat will detect `mcp.json` and offer to enable the configured servers on first launch.

## What you get

- `.vscode/mcp.json` — Copilot-compatible MCP server registry with sensible defaults (filesystem, fetch, memory)
- `.github/copilot-instructions.md` — repo-scoped instructions Copilot Chat reads automatically
- `harness.config.json` — MetaHarness manifest declaring the host, template, and validation rules
- `package.json` with `harness` CLI wired up for doctor/validate/sync workflows
- `agents/` directory with one starter agent definition and a README on how to add more
- `.gitignore` and `.vscodeignore` tuned for MCP server logs and local secrets

## Advanced

Run the built-in health check after scaffolding to confirm Copilot can see the config:

```bash
$ harness doctor
[ok] VSCode detected (1.95.0+)
[ok] .vscode/mcp.json valid (3 servers declared)
[ok] copilot-instructions.md present
[ok] node >= 20
```

Validate your `mcp.json` against the Copilot schema before committing:

```bash
$ harness validate --strict
validating .vscode/mcp.json...
  servers.filesystem    ok
  servers.fetch         ok
  servers.memory        ok
all checks passed
```

Inspect the resolved config that Copilot will actually load (useful when diagnosing why a server is silently disabled):

```bash
$ harness sync --dry-run
would write: .vscode/mcp.json
would write: .github/copilot-instructions.md
no changes (config in sync)
```

## FAQ

**Q: Do I need a Copilot subscription for this?**
A: Yes — this scaffolds config for the Copilot Chat extension in VSCode, which requires an active GitHub Copilot subscription. The scaffold itself is free.

**Q: Will this work with Copilot in JetBrains or Neovim?**
A: Not directly. The `.vscode/mcp.json` format is VSCode-specific. JetBrains uses a different MCP integration path; pick a different host template for that.

**Q: Can I commit `.vscode/mcp.json` to a shared repo?**
A: Yes, and it's recommended for team consistency. Keep secrets out of it — use `${env:VAR}` substitution and document the required env vars in `copilot-instructions.md`.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/532201b1e66c528df87857002a1c0ad9
