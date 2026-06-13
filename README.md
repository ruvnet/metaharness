<div align="center">

# agent-harness-generator

**Scaffold your own focused AI agent harness — like [ruflo](https://github.com/ruvnet/ruflo), uniquely yours.**

[![npm — coming soon](https://img.shields.io/badge/npm%20create--agent--harness-coming%20soon-cb3837?style=for-the-badge&logo=npm)](https://github.com/ruvnet/agent-harness-generator)
[![Status — scaffold landed](https://img.shields.io/badge/status-scaffold%20landed%20%2F%20iter%201-f59e0b?style=for-the-badge)](docs/adrs/INDEX.md)
[![License MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)

[![Claude Code](https://img.shields.io/badge/Claude_Code-supported-D97757?style=for-the-badge&logoColor=white&logo=anthropic)](https://code.claude.com/docs/en/mcp)
[![Codex](https://img.shields.io/badge/OpenAI_Codex-supported-412991?style=for-the-badge&logoColor=white)](https://developers.openai.com/codex)
[![pi.dev](https://img.shields.io/badge/pi.dev-supported-8b5cf6?style=for-the-badge&logoColor=white)](https://pi.dev/)
[![Hermes](https://img.shields.io/badge/Hermes_Agent-supported-06b6d4?style=for-the-badge&logoColor=white)](https://hermes-agent.nousresearch.com/docs/)

[![Rust + WASM](https://img.shields.io/badge/kernel-Rust_%2B_WASM-orange?style=for-the-badge&logo=rust)](docs/adrs/ADR-002-kernel-boundary.md)
[![NAPI-RS](https://img.shields.io/badge/native-NAPI--RS-blue?style=for-the-badge)](https://napi.rs/)
[![GCP-gated publish](https://img.shields.io/badge/publish-GCP_secret_gated-22c55e?style=for-the-badge&logo=googlecloud)](.github/workflows/publish.yml)
[![Witness signed](https://img.shields.io/badge/witness-Ed25519_signed-22c55e?style=for-the-badge)](docs/adrs/ADR-011-witness-and-provenance.md)

</div>

> **One line:** A marketplace plugin + CLI that scaffolds your own focused, vertical AI agent harnesses — with their own `npx <name>` command, MCP server, memory, learning loop, and brand — that run unchanged on Claude Code, Codex, pi.dev, and Hermes.

> **One paragraph:** [Ruflo](https://github.com/ruvnet/ruflo) bundles primitives (MCP server, hooks, memory bridge, swarm coordinator, intelligence pipeline, claims, routing) WITH opinionated content (60+ agents, 30+ skills, 33 plugins). `agent-harness-generator` factors those apart. You pick the primitives, pick the content, supply a name + brand, and out comes a brand-new npm-publishable harness with its own CLI, MCP registration, memory namespace, and marketplace identity — running on the host of your choice.

---

## Status

**Scaffold landed.** The Rust workspace, npm workspace, CI matrix, and GCP-gated publish pipeline are committed. Implementation work continues on a `/loop`-driven cadence. The 17 ADRs in [`docs/adrs/`](docs/adrs/INDEX.md) define the design.

| Layer | Status | Where |
|---|---|---|
| Kernel design | Designed | [ADR-002](docs/adrs/ADR-002-kernel-boundary.md), [ADR-002a](docs/adrs/ADR-002a-rust-wasm-napi-publishing-pipeline.md) |
| Rust crate skeleton (7 subsystems) | Scaffolded | [`crates/kernel/`](crates/kernel/) |
| WASM bindings (wasm-bindgen) | Scaffolded | [`crates/kernel-wasm/`](crates/kernel-wasm/) |
| NAPI-RS bindings | Scaffolded | [`crates/kernel-napi/`](crates/kernel-napi/) |
| `@ruflo/kernel` runtime resolver | Scaffolded | [`packages/kernel-js/`](packages/kernel-js/) |
| `create-agent-harness` CLI | Stub | [`packages/create-agent-harness/`](packages/create-agent-harness/) |
| CI (Rust + wasm + Node matrix) | Wired | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| Publish pipeline (GCP Workload Identity Federation) | Wired | [`.github/workflows/publish.yml`](.github/workflows/publish.yml) |
| Security (cargo-audit, cargo-deny, npm-audit, CodeQL) | Wired | [`.github/workflows/security.yml`](.github/workflows/security.yml) |
| Smoke test contract | Wired | [`scripts/smoke.mjs`](scripts/smoke.mjs) |
| Host adapters (Claude Code / Codex / pi.dev / Hermes) | Iter 2+ | [ADR-004](docs/adrs/ADR-004-host-integration-model.md) |
| Templates + composer | Iter 2+ | [ADR-003](docs/adrs/ADR-003-generator-architecture.md) |

---

## Architecture in 60 seconds

```
   Your users
       |
       v
   npx <your-name>             <- Identity (rename + brand)
       |
       v
   <your-harness>              <- Content (your agents/skills/plugins/prompts)
       |
       v
   @ruflo/kernel               <- Kernel (shared primitives, Rust + WASM + NAPI-RS)
       |
       v
   Host adapter                <- Per-host abstraction
   (Claude Code / Codex / pi.dev / Hermes)
       |
       v
   LLM providers
```

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
