# `@metaharness/*` — one-command example harnesses

Each package here is a **thin, runnable wrapper** around the
[`metaharness`](https://www.npmjs.com/package/metaharness) CLI. Running one
scaffolds a ready-to-edit agent harness pre-wired for a specific host or a
specific vertical workflow — no flags to remember.

```bash
# Host integrations
npx @metaharness/claude-code  my-bot   # Claude Code workspace + plugin
npx @metaharness/codex        my-bot   # OpenAI Codex
npx @metaharness/hermes       my-bot   # Hermes cli-config
npx @metaharness/pi-dev       my-bot   # pi.dev AGENTS.md
npx @metaharness/openclaw     my-bot   # OpenClaw .openclaw/
npx @metaharness/rvm          my-bot   # RVM deployment partition
npx @metaharness/copilot      my-bot   # VSCode / Copilot mcp.json
npx @metaharness/opencode     my-bot   # OpenCode .opencode/
npx @metaharness/github-actions my-bot # GitHub Actions CI/CD (non-interactive)

# Vertical workflows (ready-made multi-agent pods)
npx @metaharness/devops          my-bot   # incident response
npx @metaharness/legal           my-bot   # contract redline (drafts only)
npx @metaharness/research        my-bot   # multi-source dossier
npx @metaharness/support         my-bot   # customer support
npx @metaharness/trading         my-bot   # quant trading (paper-by-default)
npx @metaharness/education       my-bot   # tutor pod
npx @metaharness/sales           my-bot   # sales pipeline pod
npx @metaharness/gaming          my-bot   # game-design pod
npx @metaharness/repo-maintainer my-bot   # OSS repo maintainer
npx @metaharness/coding          my-bot   # engineering pod
```

Every scaffold ships:

- a `.harness/manifest.json` (signed-shape provenance),
- host-specific config (`.claude/`, `.codex/config.toml`, `cli-config.yaml`, …),
- a `.claude-plugin/plugin.json` so `claude -p --plugin-dir <bot>` loads it as a plugin,
- and the matching `@ruflo/host-<name>` adapter dependency.

After scaffolding:

```bash
cd my-bot && npm install
npx harness doctor          # health-check the scaffold
npx harness validate        # full umbrella: doctor + verify + path-guard + mcp
```

Each package has its own `README.md` (intro / quickstart / features / advanced
/ FAQ) and an explainer gist. They're all generated from — and stay in sync
with — the canonical [`metaharness`](https://www.npmjs.com/package/metaharness)
templates, so a scaffold from `@metaharness/devops` is byte-identical to
`npx metaharness my-bot --template vertical:devops --host claude-code`.

> These wrappers exist purely for discoverability and one-command ergonomics.
> The full CLI (20 templates × 8 hosts, plus `harness` subcommands) lives in
> [`metaharness`](https://www.npmjs.com/package/metaharness).
