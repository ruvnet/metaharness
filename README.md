<div align="center">

# agent-harness-generator

### Paste any GitHub repo. Get a custom AI agent harness for it.

[**Open the Studio →**](https://ruvnet.github.io/agent-harness-generator/)

[![Open the Studio](https://img.shields.io/badge/Studio-open_in_browser_↗-7c5cff?style=for-the-badge&logo=githubpages&logoColor=white)](https://ruvnet.github.io/agent-harness-generator/)
[![User guide](https://img.shields.io/badge/User_guide-plain_language-22c55e?style=for-the-badge)](docs/USERGUIDE.md)
[![Tests — 568 passing](https://img.shields.io/badge/tests-568%20passing-22c55e?style=for-the-badge)](docs/ARCHITECTURE.md)
[![License MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)

[![Agent Harness Studio](docs/web-ui/screenshot-desktop.png)](https://ruvnet.github.io/agent-harness-generator/)

</div>

---

## What this is

**Every serious repo deserves its own agent.** A repo-aware CLI, a repo-aware coding agent, a local MCP server, memory scoped to the project, skills generated from the actual file layout, governance policy, release verification, witness-signed provenance.

`agent-harness-generator` builds those, on demand, from a GitHub URL or a blank slate. **It is not another agent framework. It is a factory for agent frameworks.**

The model is replaceable. The harness is the product.

## What it gives you

In under 60 seconds, in your browser, with nothing leaving your machine:

- A custom AI agent harness for your repo (or any repo)
- Recommended agents, skills, slash commands, MCP tools
- A scoped memory namespace + governance policy
- Witness-signed provenance + release gates
- Drops into Claude Code, OpenAI Codex, pi.dev, Hermes, OpenClaw, or RVM — pick one or all

Output is an npm-publishable `.zip` with **your name on it, your branding, your `npx <your-name>` CLI**.

## Try it in 30 seconds

```bash
# In the browser — zero install, nothing leaves the page
open https://ruvnet.github.io/agent-harness-generator/

# Or in the terminal — same scaffold, byte-identical
npx create-agent-harness my-bot --template vertical:coding --host claude-code
cd my-bot && npx . --help
```

**Don't know what to pick?** Run the wizard:

```bash
npx create-agent-harness --wizard
```

**Already have a repo you want a harness for?**

```bash
harness analyze-repo .                       # local — deterministic analysis only
harness analyze-repo . --scaffold my-bot     # materialise the recommended harness
```

No repository code is executed. Inferred build/test commands are emitted as `trust: inferred · execution: disabled`.

📖 **[Read the plain-language user guide →](docs/USERGUIDE.md)**

---

## Hosts

The same harness output runs on six agent hosts:

| Host | What ships | Notes |
|---|---|---|
| [**Claude Code**](https://code.claude.com/docs/en/mcp) | MCP server + hooks + 3-scope settings | Richest surface; Ruflo-native |
| [**OpenAI Codex**](https://developers.openai.com/codex) | MCP via `~/.codex/config.toml` | TOML, no hooks |
| [**pi.dev**](https://pi.dev/) | Pi extension via `pi.registerTool()` | No MCP by design |
| [**Hermes**](https://hermes-agent.nousresearch.com/docs/) | MCP runtime, `<think>` scrubbing | Per Hermes issue #741 |
| [**OpenClaw**](https://github.com/openclaw/openclaw) | `~/.openclaw/openclaw.json` + workspace skills | Personal-AI gateway |
| [**RVM**](https://github.com/ruvnet/rvm) | Bare-metal microhypervisor + capability tokens | Hardware isolation for untrusted peers |

See [ADR-004 — Host integration model](docs/adrs/ADR-004-host-integration-model.md).

---

## MCP — modular, default-deny

MCP is included as a first-class **adapter surface, not the identity**. It is gated and default-deny ([ADR-022](docs/adrs/ADR-022-mcp-primitive.md)):

- Modes: `off` · `local` (stdio) · `remote` (HTTPS + auth)
- Emits `src/mcp/{server,tools,resources,prompts,policy,audit}.ts` + a scannable `.harness/mcp-policy.json`
- Safe defaults: no network, no shell, no file-write, approve-dangerous, 30s timeout, 8 calls/turn, audit on
- `harness mcp-scan <path>` — *"npm audit for agent tools"*: static-only scan flagging shell/network grants, missing audit/timeouts, wildcard permissions, unguarded secrets, unpinned deps. Exits 1 on any HIGH.

---

## Verticals (19 quick-start templates)

```bash
npx create-agent-harness --list
npx create-agent-harness my-bot --template vertical:coding
```

| Category | Templates |
|---|---|
| Starter / Operations | `minimal`, `vertical:devops` |
| Engineering | `vertical:coding`, `vertical:ai` |
| Knowledge | `vertical:research`, `vertical:ruview`, `vertical:education` |
| Finance / Pro | `vertical:trading`, `vertical:legal`, `vertical:health` |
| Customer / Growth | `vertical:support`, `vertical:crm`, `vertical:marketing`, `vertical:advertising`, `vertical:sales` |
| Business / Frontier | `vertical:business`, `vertical:agentics`, `vertical:gaming`, `vertical:exotic` |

Each ships bespoke domain agents (with system prompts), skills, commands, and per-host settings — all default-deny.

---

## Day-to-day commands

After scaffolding, every harness has a `harness` CLI:

| You're trying to … | Subcommand |
|---|---|
| Smoke-check the scaffold | `harness doctor` |
| Run every release gate | `harness validate` |
| Check kernel ↔ harness compatibility | `harness diag` |
| File a useful support ticket | `harness diag --bundle > bundle.json` |
| Diff two harnesses | `harness compare a/ b/` |
| Share MCP + Bash + claims config for review | `harness export-config` |
| Run npm-audit per-harness | `harness audit --bundle > audit.json` |
| Emit SPDX-2.3 SBOM | `harness sbom` |
| Drift-detect against the latest template | `harness upgrade` |
| Sign / verify the witness | `harness sign` · `harness verify` |
| Pin the manifest to IPFS | `harness publish --confirm` |
| Recommend a harness from a repo | `harness analyze-repo` |

17 subcommands total. Every one respects `--help` / `-h`. Shell completion: `harness completions bash | zsh | fish`.

📖 Full reference: [docs/USAGE.md](docs/USAGE.md)

---

## Status

Production-ready release pipeline. CI matrix green: 16 jobs across Rust × 3 OS + WASM × 3 OS + Node 20+22 × 3 OS + Bench + pack+install × 3 OS + CI-passed aggregator. Single-command releases (`node scripts/release.mjs <bump> --push`) atomically bump 15 sources, run all gates, and tag.

| Layer | Status |
|---|---|
| Rust kernel (WASM + NAPI-RS) | Shipped — 7 subsystems |
| 6 host adapters | claude-code · codex · pi-dev · hermes · openclaw · rvm |
| 17 `harness` subcommands | Shipped |
| 7 Codex skills | Shipped |
| Claude marketplace plugin | Shipped + schema-validated |
| Witness signing (Ed25519) | Shipped + tamper-tested |
| MCP tool dispatch | 11 end-to-end cases |
| Test suite | **568/568** across 67 files |
| CI matrix | 16 jobs green |
| Security pipeline | cargo-audit · cargo-deny · npm-audit · CodeQL · SBOM (SPDX-2.3) |
| Publish pipeline | GCP WIF + 2 gates + 11 packages + IPFS pin |
| Agent Harness Studio | Live at <https://ruvnet.github.io/agent-harness-generator/> |

---

## Architecture in 30 seconds

```
You (harness author)
   └→ agent-harness-generator    ← the factory
        └→ Your harness (.zip)    ← what you ship
             ├ npx <your-name>     ← your identity
             ├ <your agents>       ← your content
             └ @ruflo/kernel       ← shared primitives (Rust + WASM + NAPI-RS)
                  └→ Host adapter (Claude Code / Codex / pi.dev / Hermes / OpenClaw / RVM)
                       └→ LLM providers
```

You operate the factory. The factory produces your harness. Your users never see the factory — only the brand and CLI you ship. The kernel ships as `@ruflo/kernel` (Rust → wasm-pack + NAPI-RS); your content stays yours.

📖 Deeper: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/adrs/INDEX.md](docs/adrs/INDEX.md) (31 ADRs)

---

## Quality gates

| Concern | Where |
|---|---|
| **CI** | [`ci.yml`](.github/workflows/ci.yml) — Rust 3-platform × fmt/clippy/test/doc + WASM build + size budget + Node 20/22 × 3-platform |
| **Publish** | [`publish.yml`](.github/workflows/publish.yml) — GCP WIF → Secret Manager → smoke → `npm publish --provenance` (SLSA L2) |
| **Security** | [`security.yml`](.github/workflows/security.yml) — cargo-audit + cargo-deny + npm-audit + CodeQL + weekly cron |
| **Provenance** | [ADR-011](docs/adrs/ADR-011-witness-and-provenance.md) — Ed25519-signed witness manifest, byte-deterministic across runners |
| **Studio liveness** | [`pages-monitor.yml`](.github/workflows/pages-monitor.yml) — daily HTTP probe of live Studio |

---

## Developer quick-start

```bash
git clone https://github.com/ruvnet/agent-harness-generator
cd agent-harness-generator

cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

npm install
npm run build:wasm
npm test
node scripts/healthcheck.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Related

- [**ruflo**](https://github.com/ruvnet/ruflo) — the meta-harness this generator factors apart
- [**ruvector**](https://github.com/ruvnet/ruvector) — vector + agentic database (memory backend)
- [**@ruvector/emergent-time**](https://www.npmjs.com/package/@ruvector/emergent-time) — memory-decay clock the kernel uses

## License

MIT — see [LICENSE](LICENSE).

> **Keywords:** agent harness, AI agent scaffolding, repo-to-agent, MCP server, Claude Code plugin, Codex plugin, pi.dev extension, hermes agent, openclaw, RVM, agentic workflow, multi-agent framework, vertical AI, Rust WASM kernel, NAPI-RS, agent memory, witness manifest, SBOM, SLSA provenance, GCP WIF, plugin marketplace.
