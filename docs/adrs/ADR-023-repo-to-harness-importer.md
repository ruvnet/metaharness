# ADR-023: Repo → Harness Importer

**Status**: Accepted
**Date**: 2026-06-14
**Related**: ADR-003 (generator architecture), ADR-020 (web generator UI), ADR-022 (MCP primitive), ADR-024 (studio + verify)

## Context

Picking a template still asks the user to know which agents, skills, commands, MCP tools, memory policy, and hosts their project needs — the cold-start problem. The highest-value move is to turn a repository itself into the input: paste a GitHub URL, and the generator recommends the harness. That changes the product from a *scaffold picker* into a *harness compiler*, and gives a consultancy an instant motion ("paste the client's repo, get a branded harness").

The risk is turning a deterministic generator into a nondeterministic black box. Two hard constraints:

1. **Determinism.** The same repo at the same commit must produce the same plan and the same zip bytes, or the provenance story (ADR-011) and the "tests prove parity" claim collapse.
2. **Safety.** Repository contents are untrusted. We must never execute repo code, run install scripts, or auto-trust inferred commands.

A sentence-embedding model (e.g. MiniLM via Transformers.js) is attractive for the "what is this repo about" step, but it is a ~25 MB browser download and introduces a non-reproducible component if used naively.

## Decision

Ship a **rule-based, pure, deterministic** Repo → Harness importer, with the embedding layer as a *future, optional refinement of one scoring term* — never the generator.

**Invariant: embeddings recommend, rules generate, tests prove parity.**

### Pipeline (all pure except the one fetch)

```
GitHub URL → fetch high-signal files → analyzeFiles() → RepoProfile
           → scoreArchetypes() → recommendPlan() → HarnessPlan
           → (user edits) → planToConfig() → buildScaffold() → zip
```

- **High-signal files only.** `README.md`, `package.json`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `go.mod`, `CONTRIBUTING.md`, `.mcp.json`, and a cheap probe for `.github/workflows`. Public via the GitHub contents API; a pasted token (kept in the browser) handles private repos / rate limits.
- **`analyzeFiles()` is pure**: it derives languages, build/test commands (from `package.json` scripts + language conventions), and MCP/Claude/Codex/CI signals, plus a lowercased token set for lexical scoring. No I/O, no code execution.
- **Archetype library**: `ai-agent-framework`, `mcp-server`, `rust-crate`, `typescript-sdk`, `data-pipeline`, `research`, `devops`, `consulting` — each maps to a real catalog template + a subset of the agent/skill/command pool that actually exists, plus a security `PolicyProfile`.
- **Auditable scoring**: `score = 0.45·semantic + 0.25·manifest + 0.15·ci + 0.10·structure + 0.05·intent`. Today `semantic` is a transparent lexical-overlap proxy (keyword ∩ repo tokens); an embedding pass can later replace *only that term* without touching the contract. Ineligible archetypes (missing a required language signal) are heavily penalised, not silently excluded, so the ranking is always explainable.
- **`recommendPlan()` is pure** and emits a `HarnessPlan` (name, hosts, template, agents, skills, commands, MCP mode, policy, risk profile). `planToConfig()` materialises it into the same editable `HarnessConfig` the manual builder uses — so a recommendation is just a *seed*, fully editable before download.

### Safety: analysis only

- No repository code is executed; no install scripts run.
- Inferred commands (`npm test`, `cargo build`, …) are emitted as **suggestions** carrying `trust: inferred` and `execution: disabled`. They are never auto-trusted and never run.
- The fetch reads text content only; nothing is written anywhere but the user's own download.

### Determinism is a tested contract

`analyzeFiles` and `recommendPlan` are pure functions of the file map; `buildScaffold` is already byte-deterministic. A test asserts that the same input yields the same plan AND the same scaffold file map, which (with the fixed-date zip from ADR-021) means the same zip bytes — the acceptance test in product terms.

## Consequences

**What gets better**

- The cold-start problem is solved: a repo becomes a recommended, editable, branded harness in one paste.
- The recommendation is fully explainable (per-archetype score breakdown shown in the UI), which is what keeps enterprise buyers comfortable.
- It stays on GitHub Pages: the only network call is to GitHub's public API, from the user's own browser.

**What this costs**

- Lexical scoring is coarser than embeddings for repos whose READMEs are sparse or misleading. Accepted as the v1 floor; the embedding term is a documented, isolated upgrade.
- The archetype library is hand-curated and must grow as new templates land. Bounded by the catalog it maps onto.

**What explicitly does not change**

- Generation is rule-based and parity-tested against the CLI renderer (ADR-003/020). The importer only chooses *inputs*; it never invents file contents.

## Alternatives Considered

- **LLM-generates-the-harness.** Rejected: non-deterministic, unauditable, and breaks provenance — the opposite of the project's thesis.
- **Embedding model as the ranker now.** Deferred: the ~25 MB download and reproducibility questions outweigh the precision gain at this stage; the score formula already reserves a slot for it.
- **Clone the whole repo in-browser.** Rejected: heavy, rate-limited, and a larger trust surface; high-signal files carry most of the signal at a fraction of the cost.
- **Server-side analyzer.** Rejected for the same reason as ADR-020 — it reintroduces a backend and a place data can leak.

## Test Contract

- **Parsing**: `parseGitHubUrl` handles https, `.git`, `git@`, and `/tree/main` forms; rejects non-GitHub URLs.
- **Profiling**: a Rust repo yields `cargo build`/`cargo test`; an MCP/TS repo sets `hasMcp` + `hasCodex` + `typescript`.
- **Routing**: a Rust crate routes to `rust-crate-harness` + `vertical:coding`; an MCP server routes to `mcp-server-harness` with `mcp: remote`; suggested commands are all `execution: disabled`.
- **Determinism (acceptance)**: identical files → identical `HarnessPlan` → identical `buildScaffold` file map. (`apps/web-ui/src/generator/__tests__/repo.test.ts`.)

## References

- ADR-003 — generator architecture (the rule-based renderer this seeds)
- ADR-022 — MCP primitive (the policy each archetype carries)
- Sentence-Transformers / MiniLM, Transformers.js — the deferred embedding layer for the `semantic` term
