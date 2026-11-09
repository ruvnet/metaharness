# MetaHarness × OpenAI Codex / Codex CLI

<!-- ruv-seo:start (ADR-356) -->
MetaHarness example — minimal OpenAI Codex / Codex CLI agent scaffold with doctor, validate, and host config.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/codex` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/codex my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 16
Manifest: ./my-bot/.harness/manifest.json

Scaffold ready at ./my-bot
Next: cd my-bot && npm install
Then: harness doctor
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/host-codex`](https://www.npmjs.com/package/@metaharness/host-codex) — the adapter that writes this host's config, if you want to generate it from your own code.
<!-- ruv-seo:end -->

## Reference

> ⚠️ **Illustrative output.** Transcripts and validation/run output shown in this README are
> representative examples, not captured from a specific run — actual output depends on your
> environment, models, and inputs. Run the commands to see real results.

A minimal, opinionated scaffold for building agent harnesses that target the OpenAI Codex CLI. It generates a ready-to-run project directory with a host-specific `codex.config.json`, a starter agent, lifecycle hooks, and the `harness` doctor/validate tooling baked in. This is for developers who want a clean starting point for a Codex-driven agent and do not want to hand-wire config, prompts, and validation. It is not a multi-agent vertical template, a UI, or a hosted runtime — you supply the logic, this gives you the skeleton.

## Quickstart

```bash
npx @metaharness/codex@latest my-bot
cd my-bot && npm install && harness doctor
```

That produces a working harness in `./my-bot`, installs dependencies, and runs the self-check so you know Codex CLI is detected and your scaffold is valid before you write a line of code.

## What you get

- `codex.config.json` — host-specific configuration the Codex CLI reads on launch (model, tools, sandbox policy, working dir).
- `agents/main.md` — a starter agent prompt with frontmatter, ready to edit.
- `hooks/` — pre-task and post-task lifecycle hook stubs wired into the harness runtime.
- `harness.json` — manifest the `harness` CLI uses for `doctor` and `validate`.
- `package.json` — minimal, no runtime deps beyond `metaharness`.
- `.gitignore`, `README.md`, and an `examples/` directory with a runnable hello-world task.
- A `scripts/dev.mjs` entry point that boots Codex CLI with the local config in one command.

## Advanced

Run the built-in self-check to confirm Codex CLI is reachable and your scaffold is healthy:

```bash
$ harness doctor
[ok]   codex cli detected (v0.18.x)
[ok]   codex.config.json parsed
[ok]   agents/main.md frontmatter valid
[ok]   hooks/ entries executable
[ok]   3/3 checks passed
```

Validate the manifest and agent files without launching anything:

```bash
$ harness validate
validating harness.json ... ok
validating agents/main.md ... ok
validating hooks/pre-task.mjs ... ok
0 errors, 0 warnings
```

Launch your agent through the Codex CLI using the scaffold's config:

```bash
codex --config ./codex.config.json --agent agents/main.md
```

## FAQ

**Do I need an OpenAI API key?**
Yes. The Codex CLI reads `OPENAI_API_KEY` from your environment. `harness doctor` will warn if it is missing but will not block scaffold creation.

**Can I rename the project after scaffolding?**
Yes. Rename the directory and update the `name` field in `harness.json` and `package.json`. Nothing else hardcodes the project name.

**How is this different from running `npx metaharness` directly?**
This package pins `--template minimal --host codex` so you skip the prompts. Under the hood it calls the same `metaharness` generator — you get the identical output as the long form, with one fewer decision to make.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/0fbbffdbeebee890f688b378f99a271a
