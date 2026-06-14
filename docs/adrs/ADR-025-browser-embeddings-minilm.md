# ADR-025: Browser Embeddings (Transformers.js MiniLM)

**Status**: Accepted
**Date**: 2026-06-14
**Related**: ADR-020 (web UI), ADR-021 (client-side packaging), ADR-023 (repo importer)

## Context

ADR-023 shipped the Repo → Harness importer with the `semantic` term of its scoring formula as a transparent lexical keyword-overlap proxy, and explicitly reserved that slot for a sentence-embedding model "without changing the contract." Lexical overlap is deterministic and free but coarse: a repo whose README uses different vocabulary than an archetype's keywords scores poorly even when the meaning matches.

The constraint that shaped ADR-023 still holds: the Studio is 100% client-side on GitHub Pages, with no backend and a "nothing leaves your browser" promise. So the embedding model must run **in the browser** — which rules out the native NAPI option (`@ruvector/ruvllm` is Node-only) and points at Transformers.js, which runs ONNX models in-page over WASM or WebGPU.

## Decision

Implement the `semantic` term with **Transformers.js MiniLM**, as an **optional, lazy, fallback-safe** upgrade — never the default, never a hard dependency of the deploy.

- **Model.** `Xenova/all-MiniLM-L6-v2` — 384-dim, the canonical lightweight sentence embedder. Fetched from the HF hub on first use and cached by the browser.
- **Lazy + code-split.** `@huggingface/transformers` is imported only inside `embeddings.ts` functions via dynamic `import()`, so it lands in its own chunk (~162 KB gz) plus the ORT WASM asset — neither is in the main bundle and neither loads unless the user opts in. The default Repo→Harness path stays on the lexical proxy, so **CI, e2e, screenshots, and the Pages deploy never download a model**.
- **WebGPU-first, WASM-fallback.** The pipeline picks `webgpu` when `navigator.gpu` exists, else `wasm`.
- **Injection, not entanglement.** `semanticScores(profile, archetypes)` returns a per-archetype map that is passed into the *existing* `scoreArchetypes(profile, semantic?)`. With no map, the pure lexical path runs unchanged. Generation never sees the model.
- **Determinism guard.** Embeddings are mean-pooled + L2-normalised; the cosine score is `round3()`'d before entering `0.45·semantic + …`. Inference is greedy (no sampling). Same text + same backend → same rounded score → same ranking. The lexical default remains fully deterministic and is what the determinism/acceptance tests assert against.
- **Graceful fallback.** Any load/inference failure (no network, blocked CDN, unsupported browser) silently falls back to lexical scoring, and the UI reports which engine actually scored the plan.

## Consequences

**What gets better**

- Semantic matching that survives vocabulary mismatch, while keeping the whole thing on Pages with no backend.
- The "embeddings recommend, rules generate, tests prove" invariant is now literally true end-to-end: a real embedding model recommends; the rule-based renderer still generates; the parity/determinism tests still pass on the deterministic default.

**What this costs**

- A ~25 MB model download (cached) + a ~23 MB ORT WASM asset in the deploy artifact. Both are off the critical path: opt-in, lazy, cached. The initial app load is unchanged.
- Cross-backend (WASM vs WebGPU) float differences could, at an exact tie, flip a ranking. Mitigated by `round3` and by keeping the rule-based terms (manifest/CI/structure) materially weighted; the determinism contract is asserted on the lexical default, and the embedding path is documented as backend-dependent.

**What does not change**

- Scaffold emission is rule-based and byte-deterministic regardless of engine; the model only reorders *recommendations*.

## Alternatives Considered

- **`@ruvector/ruvllm` (NAPI).** Ecosystem-aligned and excellent for a future Node-side `harness analyze-repo`, but it ships per-platform native binaries and cannot run in a browser — wrong layer for the Pages Studio. Recommended for the CLI mode instead.
- **Always-on embeddings.** Rejected: forces a 25 MB+ download on every visitor and makes the deploy depend on a model — the opposite of the lazy, no-backend promise.
- **Bundle the model weights into the deploy.** Rejected: bloats the artifact for everyone; the HF hub + browser cache is the right delivery path. (The ORT *runtime* is self-hosted, so only weights come from HF.)
- **A bigger embedder (e5/bge).** Overkill for short repo-vs-archetype matching; MiniLM's 384-dim throughput is the better browser fit.

## Test Contract

- **Pure math**: `cosine` (identical→1, orthogonal→0, zero-vector→0 no NaN), `clamp01`, `round3`, `profileText`/`archetypeText`. (`embeddings.test.ts`.)
- **Injection**: an injected semantic map deterministically changes the ranking and re-running yields the identical result; with no map the lexical contract (Rust repo → `rust-crate-harness`) is unchanged.
- **e2e**: selecting the MiniLM engine reveals the model/back-end note; the model is **not** fetched until Analyze, so the suite stays offline-safe.

## References

- ADR-023 — the importer this completes (the reserved `semantic` slot)
- Transformers.js — in-browser ONNX over WASM/WebGPU
- `sentence-transformers/all-MiniLM-L6-v2` — 384-dim sentence embedder
