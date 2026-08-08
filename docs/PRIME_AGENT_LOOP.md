# Prime Agent integration — autonomous loop worker directive

Versioned source of truth for the `/loop` worker driving ADR-246 + ADR-247 to Implemented. **Cadence: self-paced, until DONE or blocked.**

## ▶ CURRENT DIRECTIVE (2026-08-06): implement ADR-246 + ADR-247 fully — swarm-per-phase, $0 external spend

Branch `claude/metaharness-improvements-research-eq6q2w`, PR **#169**. Implement in **Rust + TypeScript (wasm)** per the kernel pattern (ADR-002/002a). Each phase runs as one **Workflow swarm** (implementers → test-writers → adversarial verifiers); the loop worker is the integrator (commit/push/tick/re-arm).

**Hard guards (never violate):**
- `meetsPromotionRule` (ADR-072) and `validateGeneratedCode` (ADR-071) are FROZEN — additive changes only around them, never edits to them.
- $0 external LLM spend: RefineMutator tests use local `node:http` mocks (the `ruvllm-mutator.test.ts` pattern). No OpenRouter/API calls.
- Baseline-diff discipline: pre-existing failures recorded at P0 are not ours to hide; only fix regressions **we** introduce. ONLY real measured numbers — never fabricate test counts.
- Host count strings use the REAL count: prime-agent is the **10th implemented** adapter (host-eve ADR-083 is Proposed-only; ADR-247's "11th host" counts it — note this when flipping status).

## Phases (tick the boxes; execute in order; one phase per wake unless trivially small)

### ★ P0 — Bootstrap + baseline (solo)
- [x] `npm install` at root; `npm --prefix apps/web-ui install`
- [x] `npm run build` (build-ordered) — DONE in 31.5s, no failures
- [x] `npx vitest run` baseline → recorded below
- [x] `cargo test --workspace` baseline → GREEN (all crates pass, 0 failures)
- [x] wasm-pack 0.13.1 installed (prebuilt musl binary → ~/.cargo/bin) + `wasm32-unknown-unknown` target added
- [x] Commit this directive + baseline numbers

**Baseline (2026-08-06, commit 411f65f):** `npx vitest run` → **21 failed | 2293 passed | 20 skipped (2334 tests; 12 failed files)**. Pre-existing failing files (NOT ours; do not fix unless we regress them further, do not count against us): `adr-index` (canonical-sections check — numbered headings in older ADRs; ADR-246/242 pass it), `agent-harness-generator-lib`, `audit-deps` (×2, network-dependent), `claude-marketplace-plugin` (×2, skill-count drift), `e2e-lifecycle`, `e2e-scaffold-validate`, `examples-quickstart`, `harness-diag` (×7), `harness-score`, `workflows` (publish.yml host regex). Full capture: scratchpad `baseline-failures.txt`. catalogCount drift ("expects 16 but catalog has 17"/"18 vs 19") appears inside doctor/e2e output — pre-existing.

### ★ P1 — `packages/host-prime-agent` (ADR-247) — swarm: implementer → test-writer → 2 verifiers — DONE (19 tests green; 6 verifier defects found+fixed: name-collision suffixing, hooks/statusLine unsupported-section, heartbeat projection, no fabricated CLI values, ADR-247 runbook filename amended to install-prime-agent.md, surrogate-safe truncation)
- [x] 6-file package mirroring `host-opencode` (`package.json` `@metaharness/host-prime-agent` 0.1.0, tsconfig, LICENSE, README)
- [x] `src/index.ts`: `HOST_NAME='prime-agent'`; renderers `skillMd` / `pyprojectToml` / `skillShimPy` / `subAgentSpec` / `supplementalPrompt` / `installMd` / `sandboxRequiredMd`; default-export `adapter`
- [x] `__tests__/index.test.ts` per ADR-247 Test Contract: frontmatter `^[a-z0-9-]+$` + ≤1024 desc; one skill dir per tool; committed golden snapshot; fail-closed `SANDBOX-REQUIRED.md` on non-empty deny (absent on empty); byte-determinism; autonomous projection; no-silent-drop
- [x] Verifiers: ADR-247 §2.1/§2.2 conformance; determinism + Python shim structural validity

### ★ P2 — Propagation — DONE (swarm 3 tracks + verifier; parity CLI↔web-ui byte-IDENTICAL; sweep 588/588, web-ui 67/67, integration 57/57, verify-all-hosts prime-agent PASS, healthcheck HEALTHY 8/8, real-measured bench baseline row; scaffold smoke emits install-prime-agent.md)
- [x] `create-agent-harness/src/index.ts:63` HOSTS + comment
- [x] `create-agent-harness/src/host-config.ts` `case 'prime-agent'` (+ "OTHER eight hosts" comment) — byte-identical with web-ui
- [x] `apps/web-ui/src/generator/scaffold.ts` `hostFiles()` same emission (ADR-027 parity)
- [x] `apps/web-ui`: `types.ts` HostId; `catalog.ts` HOSTS; `HostGuide.tsx` union+GUIDES (≥2 steps); `verify.ts` hostArtifacts
- [x] `packages/bench`: host-bench.ts import+push; package.json dep; host-baseline.json row; `__tests__/host-bench.test.ts` set → 10
- [x] `apps/web-ui/.../host-guide.test.ts` exhaustive array → 10
- [x] `scripts/verify-all-hosts.mjs` HOSTS + checks + realChecks (skip-gated); `scripts/verify-harness-live.mjs` HOSTS + extractCapabilities branch
- [x] `scripts/build-ordered.mjs` phase-3 list; `scripts/healthcheck.mjs` INDEPENDENT set
- [x] `.github/workflows/published-smoke.yml:201` host loop
- [x] `scripts/publish-workspace.mjs` RELEASE_ORDER **together with** `__tests__/publish-workspace.test.ts`
- [x] `.claude-plugin/plugin.json` ↔ `claude-marketplace-plugin.test.ts`; `.codex/skills/create-harness/skill.toml` ↔ `codex-skills.test.ts`
- [x] Verify auto-covered paths (wizard, HarnessBuilder, `{{host}}` templates, root multi-host integration tests)

### ★ P3 — `autonomous` HarnessSpec block, Rust + TS (ADR-246 §2.2) — swarm: 2 implementers (TS/Rust) → test-writer → verifier
- [x] TS: `kernel-js/src/types.ts` + `projects/src/harness-spec.ts` (`HarnessSpec` AND `HarnessGenomeLite`, verbatim copy both directions — the `policy` pattern); `validateSpec` flat-string checks (must not fire on `defaultSpec()`); `replaySpec` additive `halt?: {reason}` on budget exhaustion
- [x] Rust: `crates/kernel/src/autonomous.rs` serde types + `validate_autonomous()` same error strings; `crates/kernel-wasm` binding `autonomousValidate` (mcp_validate pattern)
- [x] Lockstep test: shared JSON fixtures → identical error lists TS ↔ Rust
- [x] Projections: host-claude-code guidance; host-prime-agent install.md snippet (P1); remaining adapters explicit no-op note + no-silent-drop contract test
- [x] Tests: round-trip ×2 stable; validation rejects (tokenBudget≤0, empty gateCommand, maxTurns<1); replay halt determinism

### ★ P4 — Recoverable session log, Rust core + wasm + TS mirror (ADR-246 §2.3) — swarm: 2 implementers → test-writer → 2 verifiers
- [x] Rust `crates/kernel/src/session.rs`: `SessionEvent{index,branch,parent?,kind,payload}`, JSONL codec, monotonic+branch validation, sha256 `state_hash` over canonical fold, `replay()`, `fork(at_index)`
- [x] wasm bindings `sessionReplay`/`sessionStateHash`/`sessionValidate` — built + smoke-tested (fixture hash reproduced through wasm; wasm-opt needed --enable-nontrapping-float-to-int --enable-sign-ext for the f64→i64 canonicalization cast; binaryen fetched via proxy, session-local)
- [x] TS mirror `kernel-js/src/session.ts` (`TrajectoryStore` prior art): append/replay/stateHash/fork/resume, pure-TS implementation
- [x] Cross-language invariant: committed fixture → identical state hash Rust ↔ TS
- [x] Scaffold toggle `--sessions/--no-sessions` (Darwin recipe: CliArgs ~167 / ScaffoldOptions ~230 / post-render block ~429); CLI-only + ADR-027 asymmetric-features note
- [x] Tests: write-N/kill/resume hash-identical; fork-at-k diverges; corrupted tail detected

### ★ P5 — RefineMutator + flywheel evidence channel (ADR-246 §2.1) — swarm: 2 implementers → test-writer → adversarial verifier
- [x] `darwin-mode/src/refine-mutator.ts` implementing `CodeGenerator`: one bounded CRUD edit/one surface; summary cites trace IDs; **no evidence → no-op** (parent unchanged); nonce-distinct siblings; local-HTTP LLM client (unreachable → no-op); output passes `validateGeneratedCode`; barrel export
- [x] flywheel additive: `CandidateMutation.inverse?:{path,parentBytes,hash}`; proposer-summary channel to lineage commit (`run.ts:149` — old signature still works)
- [x] Tests (mirror mutator/ruvllm-mutator tests): one-surface; evidence IDs; no-op paths; validate-pass; apply→rollback byte-identical; refine child failing frozen scorer NOT promoted; `gateFingerprint` unchanged

### ★ P6 — PTC experiment manifest (ADR-246 §2.4) — solo
- [x] `packages/evals-toolcall/experiments/ptc-ab.json` (arms, metrics, seeds, criterion ≥20% token cut @ non-inferior success α=0.05, SYNTHETIC discipline)
- [x] `packages/evals-toolcall/__tests__/ptc-ab.test.ts` (exists/parses/pre-registers)

### Fix round (2026-08-06) — DONE: P3-P6 adversarial-verify findings
Swarm implemented P3-P6 green on own tests (Rust 110 pass + clippy -D warnings clean; TS sweeps green; PTC 6 tests). Adversarial verifiers then CONFIRMED cross-language divergences now being fixed by a 3-fixer swarm + re-verifier:
- session: TS UTF-16 vs Rust byte-wise key sort; integral-float/-0 canonicalization (1.0 vs 1); TS-writable lone surrogates unreadable by Rust; root-with-parent accepted by Rust only; whitespace-line skip vs error; cascade resync mismatch; fork API asymmetry (synthetic event vs pendingParent); literal NUL bytes in session.ts source.
- autonomous: TS accepted non-integer maxTurns/tokenBudget (Rust parse-rejects); null-field crashes in TS validateSpec; Rust null-serialization crashing TS; copyAutonomous undefined-key injection.
- refine: ProposerResult missing from barrel; res.ok unchecked; timer leak; zero-width-char evidence bypass; gitignored dist/refine-mutator.js vs tracked dist barrel (checkout crash).
Resolutions chosen: TS sorts keys byte-wise; Rust normalizes integral floats to JS form (hash contract is canonical-JSON, not wire bytes); TS rejects unpaired surrogates at append; Rust rejects root-with-parent; TS skips whitespace lines + resyncs after gap; TS fork emits synthetic fork event (Rust parity); null = absent both sides; integer enforcement both sides w/ existing lockstep strings; session validation MESSAGES documented as per-language diagnostics (hash + accept/reject is the contract).

### ★ P7 — Optimize + README/docs + finish — DONE (2026-08-06)
- [x] Full `npx vitest run` + `cargo test --workspace` + `cargo clippy` — fix OUR regressions only (baseline diff)
- [x] Simplify pass over new code only
- [x] README: `### New` item (Weight-EFT ADR-link pattern) · `## Hosts` nine→ten + row · stale counts :39/:265/:379/:400 · `docs/USERGUIDE.md`/`USAGE.md`/`ARCHITECTURE.md`/`RELEASE.md` · `create-agent-harness/README.md` · CHANGELOG entry
- [x] Flip ADR-246/242 Status → Implemented (2026-08-06) with honest per-section notes (PTC stays deferred by design); INDEX.md summaries match
- [x] Scaffold smoke: `npx metaharness tmp-bot --host prime-agent`; deny-list spec → SANDBOX-REQUIRED.md
- [x] Push, update PR #169 description checklist, one summary comment, STOP loop

## Each tick
1. **HEALTH** — `git status -sb` (right branch, clean or known WIP); read this doc's boxes.
2. **RUN** — execute the next unchecked phase via its Workflow swarm (worktree isolation only where parallel agents would touch the same files).
3. **VERIFY** — targeted `npx vitest run <paths>` + `cargo test` for touched crates; adversarial verify agents on new contracts.
4. **UPKEEP** — commit (scoped message), push with retry/backoff, tick boxes here, refresh PR checklist.
5. **RE-ARM** — ScheduleWakeup: ~60–120s if next phase ready; 1200s+ fallback while a swarm is in flight (task notifications are the primary signal).

## LOOP COMPLETE (2026-08-06)

All phases done. Final gate: full `npx vitest run` failing set **byte-identical to the P0 baseline** (21 pre-existing failures / 12 files — none ours; 243 files passing incl. all 6 new suites, 257 total vs 251 at baseline); `cargo test --workspace` all green (116 kernel tests + all crates); `cargo clippy --workspace -D warnings` clean; wasm build + fixture-hash smoke green. ADR-246/242 flipped to Implemented. PR #169 carries the full integration.

## Stop / complete condition
Stop when ALL phases are checked AND full vitest is no worse than the P0 baseline AND `cargo test --workspace` is green AND README/docs updated AND everything is pushed to PR #169. Then post ONE summary comment on the PR and stop the loop. If blocked >2 ticks on the same item, record the blocker here honestly and surface it on the PR instead of spinning.

See `docs/adrs/ADR-246-prime-agent-continual-harness-refine.md` · `docs/adrs/ADR-247-host-prime-agent.md` · `docs/research/scaffolding/PRIME-AGENT-ANALYSIS.md` · `docs/LOOP_WORKER.md` (format precedent).
