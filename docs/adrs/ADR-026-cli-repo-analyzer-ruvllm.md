# ADR-026: CLI Repo Analyzer (`harness analyze-repo`) with optional ruvllm embeddings

**Status**: Accepted
**Date**: 2026-06-14
**Related**: ADR-023 (browser repo importer), ADR-025 (browser MiniLM embeddings)

## Context

ADR-023 shipped Repo → Harness in the browser; ADR-025 added optional in-browser MiniLM embeddings. The browser path is privacy-first and zero-install, but it is bounded by the GitHub API (rate limits, public-by-default) and by what is safe to fetch over the network. The "serious use" path the importer's own design called out — private repos, the full local tree, real byte parity — belongs on the CLI, where there is a filesystem and a Node runtime.

Two decisions to make: how the CLI analyzer relates to the browser one, and what to use for embeddings on the Node side. For embeddings, `@ruvector/ruvllm` is the ecosystem-native option (same `@ruvector/*` family as the kernel's memory clock), but it is a NAPI package — which is exactly why it is *unsuitable* for the browser (ADR-025) and *well-suited* here.

## Decision

Add `harness analyze-repo [path]` — a local, analysis-only repo analyzer that mirrors the browser importer's rule-based core, with `@ruvector/ruvllm` as an **opt-in** (`--embed`) deterministic embedding engine and a transparent lexical fallback.

### Same rules, Node-side

`analyze-repo.ts` ports the browser's pure core: `inventory()` (safe file walk), `analyzeFiles()`, the 8-archetype library, the auditable `0.45·semantic + 0.25·manifest + 0.15·ci + 0.10·structure + 0.05·intent` score, and `recommendPlan()`. Archetypes map to the same catalog templates and agent ids, so a CLI recommendation scaffolds a real harness via the existing `scaffold()`. Outputs `repo-profile.json` + `harness-plan.json`, and `--scaffold <name>` materialises the plan.

### Safety: analysis only

- Only **high-signal files** are read (README, manifests, CI/host presence); `node_modules`, `.git`, `dist`, `target`, `build`, etc. are never read. No repository code is executed.
- Inferred build/test commands are emitted as suggestions carrying `trust: inferred · execution: disabled` — surfaced, never run.

### Embeddings via ruvllm — opt-in, deterministic, offline

- `@ruvector/ruvllm` is an **optionalDependency**: install never fails without its native binary, and nothing on the default path imports it.
- It is loaded through `createRequire(import.meta.url)` against its CJS build (its ESM entry ships extensionless imports Node can't resolve) — a deliberate, documented workaround.
- `new RuvLLM().embed(text)` is a **pure, deterministic** function of its input (verified: same text → identical vector), runs **locally and offline**, and needs no model download. So unlike the browser's WASM-vs-WebGPU caveat, the CLI embedding ranking is *fully deterministic* — strengthening, not weakening, the parity story.
- Scores are `round3()`'d and injected into the same `scoreArchetypes(profile, semantic?)`; generation stays rule-based. Any failure (missing dep/binary) silently falls back to lexical, and the CLI reports which engine scored the plan.

### Why not in the browser

`@ruvector/ruvllm` ships per-platform native binaries (`-linux-x64-gnu`, `-darwin-arm64`, …) and cannot load in a browser — it would break the Pages/no-backend invariant. The browser keeps MiniLM (ADR-025); the CLI gets ruvllm. Two engines, one rule-based core, one invariant.

## Consequences

**What gets better**

- Depth: full local tree, private repos, no rate limits, offline.
- A *more* deterministic embedding path than the browser (pure JS, no backend variance) — the CLI's `analyze-repo` is the reference for the acceptance test "same repo+SHA → same plan".
- One command goes repo → plan → scaffold without leaving the terminal.

**What this costs**

- A second copy of the archetype library + scoring (Node vs. browser package boundary). Small and pinned by tests on both sides; a future refactor could extract a shared `@ruflo/repo-archetypes` package.
- A documented `createRequire`/CJS workaround for ruvllm's ESM packaging bug — revisit when upstream fixes it.

## Alternatives Considered

- **Share one analyzer package across CLI + browser.** Cleaner long-term, but the browser bundle and the Node CLI have different module/runtime constraints; porting now, extracting later, was the lower-risk path.
- **Bundle ruvllm as a hard dependency.** Rejected: native binaries that may not exist on every platform must never block `npm install` or the default analyze path.
- **Use MiniLM (Transformers.js) on the CLI too.** Possible, but ruvllm is ecosystem-native, fully offline, and deterministic — a better Node fit; MiniLM stays the browser engine.

## Test Contract

- `inventory` reads high-signal files and **never** reads `node_modules`/build dirs.
- `analyzeFiles` detects rust + `cargo build`/`cargo test` + CI; `recommendPlan` routes a Rust crate to `rust-crate-harness` (lexical), commands `execution: disabled`.
- `ruvllmSemantic` returns a deterministic, rounded per-archetype map **or** `undefined` (fallback) — the test passes either way, so CI is independent of the optional binary.
- `analyzeRepoCmd` writes `repo-profile.json` + `harness-plan.json`; `--scaffold` materialises the harness into `--out` (never pollutes cwd).

## References

- ADR-023 — the browser importer this mirrors · ADR-025 — the browser embedding engine (MiniLM)
- `@ruvector/ruvllm` — local self-learning LLM runtime (NAPI), `RuvLLM.embed()` + `cosineSimilarity`
