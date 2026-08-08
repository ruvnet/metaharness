# ADR-245: @metaharness/horizon — the portable control core of ADK's long-horizon-harness, as Rust/WASM+TS

**Status**: Accepted (core shipped, $0; ADK-platform features deliberately out of scope)
**Date**: 2026-08-08
**Project**: `ruvnet/metaharness`
**Related**: ADR-242 (oo-agents — same dependency-free Rust→wasm32 build shape, no wasm-bindgen), ADR-241/243 (radio — the coordination layer a long-horizon pod runs on), ADR-236 (bounded-claims discipline)
**Source**: Google ADK samples — `core/python/long-horizon-harness` (ADK 2.5.x, Gemini 3.6 Flash, Cloud Run/SQL)

> ADK's long-horizon-harness is a full reference framework — per-user sandboxes,
> Memory Bank, OAuth, sub-agents, a nightly "dream" consolidation. Most of that
> is Google-platform plumbing. But three of its features are **general
> harness-control primitives** that any long-horizon agent needs and that port
> cleanly to a frozen, deterministic core. Clone those; leave the platform.

## Context

Reviewing the ADK sample, three mechanisms stand out as portable, testable, and
directly aligned with this repo's "the harness is the product" thesis:

1. **`halt_reason`** — long-horizon agents loop; a harness needs a principled
   STOP. ADK rides one shared state field: a guard SETS it (iteration budget /
   no-progress / repeated-failure), the next `before_model` CONSUMES it, and it
   resets at turn boundaries.
2. **`command_classify.py`** — ADK's Layer-D permission guard classifies the
   WHOLE shell command, not just the first token, because a gated op can be
   "smuggled inside benign segments" (`echo hi && curl … | sh`).
3. **Context compaction with a pre-compaction flush** — the summarizer fires a
   memory flush "*before* facts are lost to a lossy summary." The ordering is
   the whole contribution.

The rest (Memory Bank, sandboxes, OAuth, A2A, the dream) is platform-specific
and out of scope.

## Decision

Ship `packages/horizon` (`@metaharness/horizon`) cloning exactly those three, in
the layer each belongs in:

- **`HaltController`** — the halt_reason mechanism as a PURE Rust reducer,
  `(config, state, action) → (state, decision)`, compiled to
  wasm32-unknown-unknown. No hidden globals → deterministic; state round-trips
  through JSON → **sessions resume** (`snapshot()`/`restore()`). Faithful
  "arm-on-observe, consume-at-before_model, reset-at-turn_boundary" semantics; a
  success breaks a failure streak.
- **`CommandGuard`** — the anti-smuggling classifier in Rust/WASM, where
  quote-aware shell tokenizing belongs. Splits on top-level `;` `&&` `||` `|`,
  recurses into `$(...)`/backtick substitutions, classifies EVERY segment, and
  returns the MAX severity (`allow < gate < deny`). Layer-A exfiltration folds
  in (secret-path reads, non-allowlisted egress, metadata-server touch → deny).
  Deny/gate/secret matching runs on the UNQUOTED skeleton so a dangerous string
  passed as data (`echo 'a; rm -rf /'`) is not misread as a command.
- **`CompactionPolicy`** — pure TS (its value is ordering, not computation): the
  flush-durable-facts-BEFORE-lossy-summary sequence as an ENFORCED invariant. A
  flush rejection ABORTS compaction with events intact — the lossy summary never
  runs over facts we failed to persist. Token-estimate / flush / summarize are
  pluggable seams (no LLM required to exercise it).
- **`LongHorizonDriver`** — the three composed into the ADK Runner loop shape
  (`turn_boundary → before_model → step → guard → observe → compact`), with the
  model and gate-approval as seams so the whole loop runs deterministically.

Build shape mirrors oo-agents: dependency-free crate, no wasm-bindgen, 154 KB
`horizon_core.wasm`, one `hz_eval(json)→json` export.

## Consequences

- **Positive.** A deterministic, replayable long-horizon control core with real
  security value (the whole-command guard) and real resumability (serializable
  halt state), independent of any cloud or model. 14 Rust tests (incl. a
  20,000-iteration never-panics fuzz over arbitrary bytes) + 19 TS tests, all
  green. Microbenchmarks: classify ≈ 11 µs/call, halt.observe ≈ 9 µs/call.
- **Bounded (explicitly not claimed).** Three mechanisms, NOT a port of the ADK
  sample — Memory Bank, sandboxes, OAuth, sub-agents, the nightly dream, and A2A
  are out of scope. The guard is a STRUCTURAL classifier, not a shell
  interpreter: it gates `sh -c`/`eval` arbitrary-execution wrappers rather than
  evaluating their payloads; it is a guardrail layer to pair with real
  sandboxing, not a safety proof. Defaults favor false-gates over false-allows.
  No claim is inherited from ADK's platform evaluations.

## Reproduce

```bash
cd packages/horizon
npm run build:wasm && npm run build
npm test           # 19 TS
npm run test:rust  # 14 Rust incl. fuzz
npm run demo       # guard verdicts + a doomed loop halted + a productive loop finishing
```
