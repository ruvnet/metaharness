<div align="center">

# agent-harness-generator

**The meta-harness for AI agents — a harness that builds other harnesses.**

Like ruflo is the meta-harness for Claude, this is the meta-harness for AI agents themselves: a system whose job is to produce focused, vertical, branded agent harnesses that run on any host. Pick primitives, pick content, supply identity → ship a npm-publishable harness with your own `npx <name>` CLI, MCP server, memory, learning loop, and witness-signed releases.

[![npm — coming soon](https://img.shields.io/badge/npm%20create--agent--harness-coming%20soon-cb3837?style=for-the-badge&logo=npm)](https://github.com/ruvnet/agent-harness-generator)
[![Tests — 412 passing](https://img.shields.io/badge/tests-412%20passing-22c55e?style=for-the-badge)](docs/ARCHITECTURE.md)
[![CI — 16 jobs](https://img.shields.io/badge/CI-16%20jobs%20green-22c55e?style=for-the-badge&logo=githubactions)](.github/workflows/ci.yml)
[![License MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)

[![Claude Code](https://img.shields.io/badge/Claude_Code-supported-D97757?style=for-the-badge&logoColor=white&logo=anthropic)](https://code.claude.com/docs/en/mcp)
[![Codex](https://img.shields.io/badge/OpenAI_Codex-supported-412991?style=for-the-badge&logoColor=white)](https://developers.openai.com/codex)
[![pi.dev](https://img.shields.io/badge/pi.dev-supported-8b5cf6?style=for-the-badge&logoColor=white)](https://pi.dev/)
[![Hermes](https://img.shields.io/badge/Hermes_Agent-supported-06b6d4?style=for-the-badge&logoColor=white)](https://hermes-agent.nousresearch.com/docs/)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-supported-ef4444?style=for-the-badge&logoColor=white)](https://github.com/openclaw/openclaw)
[![RVM](https://img.shields.io/badge/RVM-hardware--isolated-1f2937?style=for-the-badge&logoColor=white)](https://github.com/ruvnet/rvm)

[![Rust + WASM](https://img.shields.io/badge/kernel-Rust_%2B_WASM-orange?style=for-the-badge&logo=rust)](docs/adrs/ADR-002-kernel-boundary.md)
[![NAPI-RS](https://img.shields.io/badge/native-NAPI--RS-blue?style=for-the-badge)](https://napi.rs/)
[![GCP-gated publish](https://img.shields.io/badge/publish-GCP_secret_gated-22c55e?style=for-the-badge&logo=googlecloud)](.github/workflows/publish.yml)
[![Witness signed](https://img.shields.io/badge/witness-Ed25519_signed-22c55e?style=for-the-badge)](docs/adrs/ADR-011-witness-and-provenance.md)

</div>

> **One line:** A **meta-harness** — a marketplace plugin + CLI that scaffolds your own focused, vertical AI agent harnesses with their own `npx <name>` command, MCP server, memory, learning loop, and brand — that run unchanged on Claude Code, Codex, pi.dev, Hermes, OpenClaw, and RVM.

> **What's a meta-harness?** A harness is a runtime that orchestrates AI agents (memory + routing + hooks + MCP + claims). A *meta-harness* is the level above: a harness whose product is OTHER harnesses. agent-harness-generator emits self-contained, npm-publishable harnesses you OWN — same kernel, your branding, your agents, your marketplace presence. The kernel updates flow to your harness via `@ruflo/kernel` npm peer; the content stays yours.

> **One paragraph:** [Ruflo](https://github.com/ruvnet/ruflo) bundles primitives (MCP server, hooks, memory bridge, swarm coordinator, intelligence pipeline, claims, routing) WITH opinionated content (60+ agents, 30+ skills, 33 plugins). `agent-harness-generator` factors those apart. You pick the primitives, pick the content, supply a name + brand, and out comes a brand-new npm-publishable harness with its own CLI, MCP registration, memory namespace, and marketplace identity — running on the host of your choice.

---

## Quick try

```bash
# 50ms scaffold → validate → cleanup, no network, exits 0 if healthy
node examples/quickstart/quickstart.mjs

# Try every supported host (claude-code | codex | pi-dev | hermes | openclaw | rvm)
node examples/quickstart/quickstart.mjs --host=codex

# 20ms two-instance federation handshake demo
node examples/federation/federation.mjs
```

See [`examples/`](examples/) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the layered map.

## Status

**Production-ready release pipeline.** Full CI matrix green: 16 jobs across Rust × 3 OS + WASM × 3 OS + Node 20+22 × 3 OS + Bench + pack+install × 3 OS + CI-passed aggregator. The release flow is a single command (`node scripts/release.mjs <bump> --push`) that bumps 15 sources atomically, runs all gates, and tags. See [ADR-019](docs/adrs/ADR-019-release-orchestration.md) for the architectural lockdown.

| Layer | Status | Where |
|---|---|---|
| Kernel (Rust + WASM + NAPI-RS) | Shipped | [`crates/kernel/`](crates/kernel/) — 7 subsystems |
| `@ruflo/kernel` runtime resolver | Shipped | [`packages/kernel-js/`](packages/kernel-js/) |
| 6 host adapters | Shipped | claude-code / codex / pi-dev / hermes / openclaw / rvm |
| `create-agent-harness` CLI | Shipped | scaffold + `harness validate / secrets / verify-witness / federate` |
| 5 Codex skills | Shipped | create / publish / validate / secrets / verify-witness |
| Claude marketplace plugin | Shipped + schema-validated | [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) |
| Witness signing (Ed25519) | Shipped + tamper-tested | [ADR-011](docs/adrs/ADR-011-witness-and-provenance.md) |
| MCP tool dispatch | Shipped + integration-tested | 11 end-to-end cases |
| Federation transport | Shipped + runnable demo | [`examples/federation/`](examples/federation/) |
| Release pipeline (6 primitives + 1 orchestrator) | Shipped | [ADR-019](docs/adrs/ADR-019-release-orchestration.md) |
| CI matrix (16 jobs across Rust + WASM + Node + Bench + pack+install) | Green | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| Security (cargo-audit + cargo-deny + npm-audit + CodeQL + audit-deps aggregate) | Green | [`.github/workflows/security.yml`](.github/workflows/security.yml) |
| Publish pipeline (GCP WIF + 2 gates + 11 packages + IPFS pin) | Wired + tested | [`.github/workflows/publish.yml`](.github/workflows/publish.yml) |
| Test suite | **412/412** | 49 test files |

| Day-to-day | Wall time | Command |
|---|---|---|
| Did I break anything? | <1s | `node scripts/healthcheck.mjs` |
| Is this scaffolded harness release-ready? | <1s | `harness validate <path>` |
| Is this branch release-ready? | ~30s | `node scripts/preflight.mjs` |
| Cut a release | ~60s | `node scripts/release.mjs patch --push` |

---

## Architecture in 60 seconds — the meta-harness pattern

```
   You                                  <- harness AUTHOR (uses the meta-harness)
       |
       v
   agent-harness-generator              <- THE META-HARNESS
   (this repo: scaffolds, signs, publishes harnesses)
       |
       v
   Your harness (npm package)           <- THE HARNESS YOU SHIP
       |
       v
   Your users
       |
       v
   npx <your-name>                      <- Identity (rename + brand)
       |
       v
   <your-harness>                       <- Content (your agents/skills/plugins/prompts)
       |
       v
   @ruflo/kernel                        <- Kernel (shared primitives, Rust + WASM + NAPI-RS)
       |
       v
   Host adapter                         <- Per-host abstraction
   (Claude Code / Codex / pi.dev / Hermes / OpenClaw / RVM)
       |
       v
   LLM providers
```

Read top-down: you (the harness author) operate the meta-harness. The meta-harness produces your harness. Your harness is what users install. They never see the meta-harness layer — only the brand and CLI you ship.

The kernel is **Rust source code compiled to two targets**: WebAssembly (primary, cross-platform) and per-platform native binaries via [NAPI-RS](https://napi.rs/) (escape hatch for hot Node paths). At load time, [`@ruflo/kernel`](packages/kernel-js/) prefers the native package for the current platform and falls back to wasm.

**Working precedent:** [`@ruvector/emergent-time@0.1.0`](https://www.npmjs.com/package/@ruvector/emergent-time) — 55 KB wasm-opt'd module shipping today through exactly this Rust → wasm-pack → npm pipeline.

---

## Host support

| Host | Integration shape | Notes |
|---|---|---|
| [**Claude Code**](https://code.claude.com/docs/en/mcp) | MCP server + 5-handler-type hooks + 3-scope settings | Ruflo-native target; richest hook surface |
| [**OpenAI Codex**](https://developers.openai.com/codex) | MCP via `~/.codex/config.toml` `[mcp_servers.*]` tables | TOML not JSON; no first-class hooks |
| [**pi.dev**](https://pi.dev/) | Pi extension (TypeScript via `pi install npm:...`) | **No MCP by design** — adapter uses `pi.registerTool()` |
| [**Hermes Agent**](https://hermes-agent.nousresearch.com/docs/) | MCP-supported runtime (`optional-mcps/`) | Adapter scrubs `<think>` + stray `<tool_call>` per [issue #741](https://github.com/NousResearch/hermes-agent/issues/741) |
| [**OpenClaw**](https://github.com/openclaw/openclaw) | MCP via `~/.openclaw/openclaw.json` + workspace skills | Personal AI assistant gateway with built-in multi-platform messaging (WhatsApp/Telegram/Slack/Discord) |
| [**RVM**](https://github.com/ruvnet/rvm) | Bare-metal microhypervisor (AArch64) with capability tokens + hash-chained witness | **Hardware-isolated** deployment for federated / multi-tenant / untrusted-peer scenarios (ADR-018) |

See [ADR-004 — Host integration model](docs/adrs/ADR-004-host-integration-model.md).

---

## Quality gates

| Concern | Where | What it does |
|---|---|---|
| **CI** | [`ci.yml`](.github/workflows/ci.yml) | Rust 3-platform matrix (fmt + clippy `-D warnings` + test + doc), wasm build + `wasm-tools validate` + 500 KB size budget, Node 20/22 × 3-platform tests |
| **Publish gate** | [`publish.yml`](.github/workflows/publish.yml) | GCP Workload Identity Federation auth → Secret Manager fetches `NPM_TOKEN` → smoke test → `npm publish --provenance` (SLSA L2) |
| **Security** | [`security.yml`](.github/workflows/security.yml) | cargo-audit, cargo-deny, npm-audit, CodeQL, weekly cron |
| **Smoke** | [`smoke.mjs`](scripts/smoke.mjs) | Kernel loads, `kernelInfo().version` matches `package.json`, `mcpValidate` accepts/rejects correctly |
| **Provenance** | [ADR-011](docs/adrs/ADR-011-witness-and-provenance.md) | Ed25519-signed witness manifest, byte-deterministic across CI runners (wasm enables this) |

---

## Quick start (developers)

```bash
git clone https://github.com/ruvnet/agent-harness-generator
cd agent-harness-generator

# Rust workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

# WASM build
npm run build:wasm

# TypeScript + smoke
npm install
npm run build
npm run smoke
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full developer workflow.

---

## Read the design (17 ADRs + INDEX)

**Start here:** [`docs/adrs/INDEX.md`](docs/adrs/INDEX.md)

Highlights:

- [ADR-001 Goals & non-goals](docs/adrs/ADR-001-goals-and-non-goals.md) — what this is and isn't
- [ADR-002 Kernel boundary](docs/adrs/ADR-002-kernel-boundary.md) — Rust + WASM + NAPI-RS
- [ADR-002a Publishing pipeline](docs/adrs/ADR-002a-rust-wasm-napi-publishing-pipeline.md) — Cargo workspace + wasm-pack + napi build
- [ADR-003 Generator architecture](docs/adrs/ADR-003-generator-architecture.md) — `create-vite`-style templates + AST-aware rename
- [ADR-004 Host integration](docs/adrs/ADR-004-host-integration-model.md) — adapter contract per host
- [ADR-006 Memory + learning](docs/adrs/ADR-006-memory-and-learning-integration.md) — `@ruvector/emergent-time@0.1.0` integration
- [ADR-009 Anti-slop](docs/adrs/ADR-009-anti-slop.md) — derived trust tiers
- [ADR-011 Witness + provenance](docs/adrs/ADR-011-witness-and-provenance.md) — signed manifests

---

## Related projects

- [**ruflo**](https://github.com/ruvnet/ruflo) — the meta-harness this generator factors apart
- [**ruvector**](https://github.com/ruvnet/ruvector) — vector + agentic database (memory backend)
- [**@ruvector/emergent-time**](https://www.npmjs.com/package/@ruvector/emergent-time) — memory-decay clock the kernel uses
- [**NAPI-RS**](https://napi.rs/) — Rust → Node bindings used for the native target

## License

MIT — see [LICENSE](LICENSE).

> **Keywords:** agent harness, agent harness generator, AI agent scaffolding, MCP server, Claude Code plugin, Codex plugin, pi.dev extension, hermes agent, multi-agent framework, agentic AI, agentic workflow, autonomous agents, agent orchestration, vertical AI harness, agent CLI generator, npm create agent, npx scaffold, Rust WASM kernel, NAPI-RS, wasm-bindgen, wasm-pack, agent memory, ReasoningBank, HNSW, emergent time, agent provenance, witness manifest, plugin marketplace, IPFS registry, drift detection, anti-slop, TDD, self-evolving agent, federated agents, swarm intelligence, GCP Workload Identity Federation, Secret Manager, SLSA provenance, npm provenance
