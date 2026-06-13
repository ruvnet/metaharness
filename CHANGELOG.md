# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — Iter 10 (2026-06-13)

- **MCP tool dispatch chain in Rust kernel** (`crates/kernel/src/dispatch.rs`):
  - `ToolCallRequest`, `Dispatch::{Invoke, NotFound, BadArgs, Denied}`
  - `dispatch()` looks up the tool, shape-checks args (must be JSON
    object), checks claims against `tool.invoke.<server>.<tool>` capability
  - `dispatch_unauthenticated()` skips claim check for SelfPeer/dev paths
  - 6 new Rust test cases including the capability-specificity case
    (allow `tool.invoke.memory.*` does NOT allow alerts)
- **Cost tracking subsystem in Rust** (`crates/kernel/src/cost.rs`):
  - `CostEvent`, `CostTotals` with per-tier breakdown +
    success/fail counts
  - `check_budget()` returns Ok(remaining) or Err(over-by)
  - `success_rate()` and `avg_cost()` derivers
  - 5 new Rust tests
- **AST-aware identifier rename** (`packages/create-agent-harness/src/
  rename.ts`):
  - Token-boundary-aware regex (no Babel dependency)
  - Skips partial-word matches (`oldName` doesn't touch `oldNameXY`)
  - Skips left-side property accesses (`obj.oldName.foo` left alone)
  - DOES rename inside string literals (intentional — error messages
    reference identifiers by name)
  - `renameFileMap()` helper for bulk transforms
  - 13 new TS tests including rule-chain ordering (a -> b -> c)
- **Tarball builder for IPFS** (`packages/create-agent-harness/src/
  tarball.ts`):
  - POSIX ustar format with FIXED metadata (mode 0644, mtime 0, uid 0,
    gid 0, ustar version "00") for deterministic sha256 across CI
    runners
  - Skips .git, node_modules, target, dist, .cache
  - 5 new TS tests including determinism + content-change-changes-hash
- **Cross-host integration smoke** (`__tests__/integration/multi-host.test.
  ts`):
  - Scaffolds minimal template for every host -> validates package.json
    declares @ruflo/host-<n>
  - Scaffolds every template for claude-code -> validates artifact
    presence
  - mcpServers config contains the harness name

### Added — Iter 9 (2026-06-13)

- **Federation transport in Rust kernel** (`crates/kernel/src/federation.rs`):
  - `Peer`, `TrustTier` (Untrusted / Trusted / SelfPeer), `Message`
    envelope, `PeerRegistry`
  - `admit_message()` security primitive: SelfPeer always admits; Trusted
    admits read-only ops without claim; everything else needs a claim
  - `is_read_only_capability()` recognises `*.read`, `*.list`, `*.search`
    plus a small allowlist
  - 11 new Rust tests pinning the admit-decision matrix
- **`harness federate` subcommand** (`packages/create-agent-harness/src/
  federate.ts`):
  - 5 subactions: `init`, `add`, `remove`, `list [--trusted]`, `status`,
    `help`
  - State persisted at `.harness/federation.json`
  - Immutable state operations (test-friendly)
  - 11 new TS tests
- **Real intelligence pipeline orchestration** (`crates/kernel/src/intel.rs`):
  - `PipelineState` with steps + completed + aborted
  - `next_phase()` advances Retrieve -> Judge -> Distill -> Consolidate;
    Skip outcomes still advance, Fail outcomes abort the pipeline
  - `should_fire_distill()` fallback predicate (judge_score >= 0.7) for
    when the TS PageHinkleyDetector isn't loaded
  - 7 new Rust tests
- **Renovate config** (`renovate.json`):
  - Weekly schedule, automerge patch/minor, group @ruflo/* and
    @ruvector/* internal
  - wasm-bindgen / wasm-bindgen-cli marked no-automerge (toolchain
    upgrades need review)
  - ed25519-dalek MAJOR bumps require explicit sign-off (security-critical
    label)
  - lockFileMaintenance enabled
- **Examples directory** (`examples/`):
  - `multi-host/` walkthrough showing one harness targeting Claude Code +
    Codex
  - `federation/` walkthrough showing 2-peer trust-tier coordination

### Added — Iter 8 (2026-06-13)

- **`harness` CLI binary** (`packages/create-agent-harness/src/harness-bin.ts`)
  with three subcommands:
  - `harness sign [path]` — produce/update witness manifest; reads
    `WITNESS_SIGNING_KEY` env (64-char hex), refuses on missing/malformed
    keys, delegates to kernel signing when available, emits a shape-valid
    placeholder otherwise (so doctor + verify report the gap explicitly)
  - `harness verify [path]` — read + verify witness.json, prints harness
    name + version + entry count + public key prefix
  - `harness doctor [path]` — smoke checks: package.json, @ruflo/kernel
    dep, .harness/manifest.json + .sha256, manifest hash consistency,
    at least one host artifact (.claude/, .codex/, AGENTS.md, or
    cli-config.yaml)
  - `harness help` — usage summary
- 11 new TS test cases for the subcommands (help, verify with/without
  witness, doctor healthy/missing-host/hash-mismatch, sign with/without
  key/with malformed key)
- Package bin map adds `harness` binary alongside `create-agent-harness`
- **MCP tool registry in Rust kernel** (`crates/kernel/src/mcp.rs`):
  - `ToolSpec` (name, server, description, JSON-schema input)
  - `ToolRegistry` with register/get/list/for_server, replaces on same
    (server, name) key
  - `validate_tool()` requires non-empty name + server, schema must be
    a JSON object
  - 7 new Rust test cases (validate-tool, registry register/get/replace,
    for-server filter)
- **Per-package READMEs** for the 6 npm-published packages:
  - `@ruflo/kernel` — kernel API + memory subpath usage
  - `create-agent-harness` — scaffold quick start + template + host matrix
  - `@ruflo/host-claude-code` — hooks three-level shape, 3 settings scopes
  - `@ruflo/host-codex` — TOML quirks (trusted-project gate, no hooks)
  - `@ruflo/host-pi-dev` — no-MCP design clarification, badlogic Pi (NOT
    Inflection)
  - `@ruflo/host-hermes` — Hermes-4 `<think>` / `<tool_call>` quirk,
    two-project disambiguation
- **GCP setup automation** (`scripts/setup-gcp.sh`):
  - One-shot bash script: APIs → WIF pool → OIDC provider → publisher SA
    → pool-to-SA binding → NPM_TOKEN secret → SA read access → variable
    wiring instructions
  - Idempotent — re-runnable; skips steps already done

### Added — Iter 7 (2026-06-13)

- **Real Hooks subsystem in Rust** (`crates/kernel/src/hooks.rs`):
  - `HandlerSpec` + `HandlerKind` (5 types per Claude Code: Command, Http,
    McpTool, Prompt, Agent)
  - `matcher_matches()` with pseudo-DSL support (`*`, `Bash(rm *)`)
  - `merge_decisions()` with defer-cascade rule + per-event default
    (PreToolUse / SubagentStart default to Ask, others to Allow)
  - 10 new Rust tests pinning matcher + merge invariants
- **Real Claims subsystem in Rust** (`crates/kernel/src/claims.rs`):
  - `check()` with wildcard + prefix-with-dot + glob resource matching
  - Expired claims skipped; first matching unexpired wins
  - 9 new Rust tests
- **Self-evolving routing TS layer**
  (`packages/kernel-js/src/self-evolution.ts`):
  - `SelfEvolvingRouter` wraps `@ruvector/emergent-time`'s
    `LearnedWeights` over the kernel router
  - `computeReward()` from success + latency + cost components
  - Graceful EMA fallback when emergent-time isn't installed
  - 8 new TS tests pinning reward computation, learning behaviour, bias
- **End-user walkthrough doc** (`docs/USAGE.md`):
  - 11-section walkthrough from install to publish to self-evolution
  - Troubleshooting table covering the 5 most likely failure modes

### Added — Iter 6 (2026-06-13)

- 3 vertical templates: trading, legal, research (5 total templates)
- Witness verification client wired into publish gate
- Marketplace registry entry generator (matches ruflo plugin registry shape)

### Added — Iter 5 (2026-06-13)

- Memory subsystem with `@ruvector/emergent-time@0.1.0` integration
- Full ruflo-eject pipeline (`--from-existing`)
- Real 3-tier routing heuristics in Rust kernel
- `vertical:support` template
- `harness publish` IPFS subcommand (Pinata)

### Added — Iter 4 (2026-06-13)

- End-to-end scaffold pipeline (template walker + atomic writer)
- `vertical:devops` template
- `harness upgrade` drift detection
- `--from-existing` ruflo-eject detection

### Added — Iter 3 (2026-06-13)

- **Real Ed25519 witness signing in Rust** (`crates/kernel/src/witness.rs`)
  - `sign_manifest()` + `verify_manifest()` using `ed25519-dalek` 2.1
  - Canonicaliser (`canonical_payload`) that sorts entries by id ascending
    for deterministic signatures across CI runners (load-bearing for ADR-011)
  - `sha256_hex()` helper for marker fingerprinting
  - 8 new tests pinning sign/verify, sort-invariance, tamper detection
  - Criterion bench (`benches/witness_sign.rs`): sign-10, sign-100, verify-50
- **Codex skills** (`.codex/skills/`):
  - `create-harness/skill.toml` + `README.md` — invoked as `/create-harness` in Codex
  - `publish-harness/skill.toml` — smoke-test + witness-sign + publish gate
  - `config.toml.example` — drop-in for `~/.codex/config.toml` MCP registration
- **GCP Workload Identity Federation setup** (`docs/setup/gcp-secrets.md`)
  - 6-step gcloud walkthrough + Terraform equivalent
  - Variable wiring (`GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_WIF_SERVICE_ACCOUNT`)
  - Rotation instructions
- **Template engine** (`packages/create-agent-harness/src/renderer.ts`)
  - Mustache-style `{{var}}` interpolation with unresolved-var reporting
  - `extractVarReferences()` for template lint
  - `validateHarnessName()` mirroring npm's rules
- **`.harness/manifest.json` schema** (`packages/create-agent-harness/src/manifest.ts`)
  - Mirrors copier's `.copier-answers.yml` for drift detection (ADR-008)
  - sha256-based file fingerprinting
  - `diffFingerprints()` returns added/removed/changed paths
- 25 new tests across renderer + manifest (29 → 54 total TS test cases)

### Added — Iter 2 (2026-06-13)

- 4 host adapter packages: `@ruflo/host-{claude-code,codex,pi-dev,hermes}`
- First template (`templates/minimal/`)
- Claude marketplace plugin manifest (`.claude-plugin/plugin.json`) + 2 skills
- Vitest config + 29 TypeScript test cases
- Rust criterion benches (`mcp_validate`, `witness_canon`)

### Added — Iter 1 (2026-06-13)

- Cargo workspace + npm workspace scaffold
- 7-subsystem Rust kernel stubs with serde round-trip tests
- WASM bindings (wasm-bindgen) + NAPI-RS bindings
- `@ruflo/kernel` runtime resolver (native → wasm fallback)
- `create-agent-harness` CLI entry point
- CI matrix (Rust × 3 platforms, wasm validate + 500 KB budget, Node 20/22 × 3 platforms)
- Publish workflow (GCP Workload Identity Federation → Secret Manager → npm provenance)
- Security workflow (cargo-audit, cargo-deny, npm-audit, CodeQL, weekly cron)
- Smoke test contract (`scripts/smoke.mjs`)

### Designed — Pre-iter (2026-06-13)

- 17 ADRs in `docs/adrs/` covering kernel boundary, generator architecture, host integration, marketplace, memory/learning, CI guards, drift detection, anti-slop, TDD, witness, eject/upgrade, vertical packs, self-evolution, naming, migration

## How releases work

This project versions to semver. Publishes are tag-driven and gated on:
1. CI matrix green
2. WASM bundle within size budget
3. Witness manifest signed
4. GCP Secret Manager NPM_TOKEN fetched via Workload Identity Federation
5. `npm publish --provenance` (SLSA L2)

No long-lived NPM token exists in any GitHub secret. See [`docs/setup/gcp-secrets.md`](docs/setup/gcp-secrets.md).
