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

```bash
# Third-party SDK showcases (ADR-051) — each wires a harness to a real platform
# SDK across every host. Read-only / sandbox / test-mode by default; mutations
# need --allow-mutations. Add --host all to emit every host's config.
npx @metaharness/example-aws         my-bot   # AWS (S3/EC2/Lambda/DynamoDB, dry-run)
npx @metaharness/example-gcp         my-bot   # Google Cloud (Storage/BigQuery/Vertex)
npx @metaharness/example-azure       my-bot   # Azure (ARM/Blob/Azure OpenAI)
npx @metaharness/example-stripe      my-bot   # Stripe billing (TEST MODE by default)
npx @metaharness/example-slack       my-bot   # Slack triage/notify (scoped tokens)
npx @metaharness/example-github      my-bot   # GitHub PR/issue automation (Octokit)
npx @metaharness/example-twilio      my-bot   # Twilio SMS/voice (magic test numbers)
npx @metaharness/example-datadog     my-bot   # Datadog incident triage (read-only)
npx @metaharness/example-supabase    my-bot   # Supabase RLS-aware data agent
npx @metaharness/example-huggingface my-bot   # Hugging Face discovery + inference
npx @metaharness/example-pinecone    my-bot   # Pinecone RAG memory
npx @metaharness/example-fhir        my-bot   # Health/FHIR (sandbox EHR; not a medical device)
npx @metaharness/example-ads         my-bot   # Google/Meta Ads analysis (read-only)
npx @metaharness/example-web3        my-bot   # web3/viem (testnet read + simulate)
npx @metaharness/example-iot         my-bot   # IoT/MQTT telemetry (guarded actuation)
npx @metaharness/example-nasa        my-bot   # NASA imagery + orbital pass prediction
npx @metaharness/example-qiskit      my-bot   # Quantum circuits (simulate, verify-first)
npx @metaharness/example-bio         my-bot   # Bioinformatics (NCBI/Ensembl lookup)
```

Every scaffold ships:

- a `.harness/manifest.json` (signed-shape provenance),
- host-specific config (`.claude/`, `.codex/config.toml`, `cli-config.yaml`, …),
- a `.claude-plugin/plugin.json` so `claude -p --plugin-dir <bot>` loads it as a plugin,
- and the matching `@metaharness/host-<name>` adapter dependency.

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
