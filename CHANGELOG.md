# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — Iter 16 (2026-06-13)

- **Full 3-platform CI matrix** — Ubuntu / macOS / Windows on every gate:
  - Rust (fmt --check / clippy -D warnings / test / doc) × 3 OS
  - WASM build + `wasm-tools validate` + 500 KB size budget × 3 OS
    (catches "works on Linux only" regressions in the wasm-pack pipeline)
  - Node 20 + 22 × 3 OS for TS tests
  - **`pack-install` job × 3 OS** — `npm pack` every published package
    then `npm install <tarball>` into a throwaway project. Catches the
    "broken files: [...] list", "missing bin script", "per-platform
    install fail" classes upstream of release.
  - Bench (smoke, Linux only — uploads `bench-report.json` artifact)
  - Final `ci-pass` aggregator job for branch-protection
- **Cross-platform path-handling guard** (`scripts/path-guard.mjs`):
  - Greps every Rust + TS source file for known-bad patterns:
    - Hardcoded `/tmp/` literals (the exact `/tmp` Windows bug that
      surfaced earlier in development — file writes appeared to succeed
      but landed somewhere bash couldn't see)
    - Hardcoded `C:\\`, `/Users/`, `/home/` absolute paths
  - Excludes tests, fixtures, and comments
  - Runs in CI on every push/PR via the Node job
- **`__tests__/path-handling.test.ts`** (8 cases): pins
  `os.tmpdir()` non-empty on every platform, posix.sep normalisation
  invariants, Windows drive-letter detection, mkdtemp parallel uniqueness
- **`@ruvector/rvf` integration** (paired with RVM per user request):
  - `@ruflo/kernel`: declares `@ruvector/rvf ^0.2.0` as optional peer
    dep + new `./memory-rvf` subpath export
  - `packages/kernel-js/src/memory-rvf.ts`: `createRvfBackend()`
    returns a `RvfBackend` wrapper over RVF's HNSW + SIMD index;
    `isRvfAvailable()` predicate; graceful null fallback when RVF
    isn't installed
  - `@ruflo/host-rvm`: emitted `wasm-guest.json` now declares
    `companion.vector_format` referencing `@ruvector/rvf` +
    `@ruvector/rvf-wasm`, marked `recommended: true`
  - host-rvm README documents the pairing (hardware-isolated vector
    storage via RVM partition + RVF binary format + RVF-wasm sub-guest)
  - 2 new TS test cases in memory-rvf + 1 new in host-rvm pinning
    the companion declaration

### Added — Iter 15 (2026-06-13)

- **`@ruflo/vertical-base` shared contract** for `@ruflo/vertical-*` packs
  (per ADR-013):
  - `VerticalPack`, `VerticalManifest`, `TemplateFileEntry`,
    `TemplateVar` interfaces
  - `readVerticalManifest(packRoot)` — reads + validates `manifest.json`
  - `validateVerticalManifest()` — throws descriptive errors on shape
    issues (missing id/description, missing src/dst/render, duplicate
    var names)
  - `verifyTemplateFilesPresent()` — pre-publish check for dangling
    references
  - 11 new TS test cases
- **`@ruflo/vertical-trading` standalone pack** — first concrete pack
  in the new pattern:
  - `templates/manifest.json` declares 10 files + 3 vars (name +
    description + host — host choices include all 6 host adapters,
    including the new RVM)
  - `load()` returns `{ manifest, templateRoot }` for the
    create-agent-harness external-template loader to consume
  - README documents the 5-agent pipeline + paper-mode-default + circuit
    breakers + Kelly multiplier + risk disclosure
  - 5 new TS test cases (templateRoot non-empty, manifest exists, load()
    returns valid, file-presence check, host choices include all 6)
- **External-template loader in CLI**
  (`packages/create-agent-harness/src/external-template.ts`):
  - `loadExternalTemplate(packageName)` dynamic-imports the pack package,
    calls its `.load()`, returns `{ manifest, templateRoot }`
  - Actionable error messages on missing package (`Did you forget to
    install it?`) + missing `load()` export + malformed result
  - CLI now accepts `--template-package @ruflo/vertical-trading` to use
    an external pack instead of a bundled template
  - 2 new TS test cases (empty packageName rejected, missing package
    error message contains install hint)

### Added — Iter 14 (2026-06-13)

- **`@ruflo/sdk` convenience helpers** for harness authors:
  - `defineAgent` / `defineSkill` / `defineTool` / `defineHook` /
    `defineMcpServer` / `defineHarness`
  - Every helper returns a frozen object (immutable post-definition)
  - Validates kebab-case names, non-empty system prompts, valid tiers,
    XOR command/url on MCP servers, name collisions across agents/skills
  - 18 new TS test cases pinning every validation rule + collision
    detection + freeze invariant
- **Browser-runtime WASM smoke fixture** (`__tests__/browser-smoke/`):
  - `fixture.html` loads `@ruflo/kernel`'s wasm bundle in a real browser
  - Runs the 3 key exports (`kernelInfo`, `mcpValidate` pass + reject)
  - Sets `window.__SMOKE_RESULT` for Playwright to read in iter 16
  - README documents how to serve the fixture today
- **Pre-publish validation script** (`scripts/preflight.mjs`):
  - 11 gates (git clean, on-main warn, version consistency, READMEs,
    publishConfig, CHANGELOG iter entry, LICENSE MIT, cargo fmt/clippy/
    test, wasm-pack build + size budget, npm test)
  - `--skip-wasm` and `--skip-rust` for faster local iterations
- **Release runbook** (`docs/RELEASE.md`):
  - 9-package release matrix (kernel + sdk + 6 host adapters + cli)
  - Step-by-step process: preflight → bump → tag → workflow fires →
    verify
  - Rollback policy (npm deprecate, never unpublish unless < 72h)
  - Dry-run workflow trigger for validating GCP auth without publishing

### Changed — Iter 13 (2026-06-13)

- **Repositioned as a META-HARNESS** in README + USAGE.md + GitHub
  description. agent-harness-generator is now explicitly positioned as
  *a harness that builds other harnesses* — the level above ruflo /
  Claude Code / etc. Architecture diagram updated to show the meta-
  harness layer above the harness-the-user-ships layer.

### Added — Iter 13 (2026-06-13)

- **`@ruflo/bench` package** — reproducible memory-retrieval benchmark:
  - 6 configs scored side-by-side (k ∈ {1,3,10} × decay ∈ {on,off})
  - Synthetic corpus + queries deterministic via `mulberry32` seed
  - 4-category eval (single-hop / temporal / multi-hop / open-domain)
    matching Mem0's shape
  - Reports recall@k, MRR, p50/p95 latency, per-category breakdown
  - JSON report header cites the Mem0 + ReasoningBank published baselines
    so users can compare against the real numbers
  - The ReasoningBank k=1 finding is testable in our shape: the report
    surfaces whether k=1 beats k=10 on temporal
  - 10 new TS test cases (cosine, decay, rank with/without decay,
    deterministic reproducibility, k-monotonicity)
- **Trajectory persistence** (`packages/kernel-js/src/trajectory.ts`):
  - `TrajectoryStore` — JSONL append-only with rotation cap
  - `append()`, `readAll()`, `rotateIfLarger(maxBytes)`, `size()`
  - 4 new TS test cases (append+read round-trip, empty-file handling,
    rotation no-op + rotation fires)
- **TS-side MCP dispatch wrapper** (`packages/kernel-js/src/dispatch.ts`):
  - `ToolDispatcher` in-process registry + dispatch with claims check
  - Structured outcome { result | denied | not-found | bad-args }
  - Honors wildcard `*` capabilities, `tool.invoke.*` suffix wildcards,
    and resource glob `agents/*`
  - Surfaces handler exceptions as denied with the message
  - 8 new TS test cases pinning every outcome path

### Added — Iter 12 (2026-06-13)

- **Sixth host adapter: `@ruflo/host-rvm`** for
  [RVM](https://github.com/ruvnet/rvm) — the Agentic Virtual Machine.
  Positioned as the **hardware-isolated deployment target** (vs the
  five OS-level adapters)
  - Generates `rvm-partition.toml` (TOML partition manifest), `capability-
    table.json` (capability tokens from kernel claims), `wasm-guest.json`
    (kernel bundle reference + F1–F4 recovery map), and idempotent
    `install-rvm.sh`
  - `rightsFromCapability()` maps the kernel's claim-capability strings
    onto RVM's 7 rights (READ/WRITE/GRANT/REVOKE/EXECUTE/PROVE/GRANT_ONCE)
  - `defaultProofTier()` derives the right's proof tier (P1 read, P2
    write/execute, P3 grant/revoke/prove)
  - `buildCapabilityTable()` lossless lift from kernel claims to RVM caps
  - **The kernel's WASM bundle IS the RVM guest** — no fork; one source,
    six deployment targets
- **ADR-018** documents RVM as the deployment target tier, the claim→
  capability mapping, the tier picture, trade-offs (AArch64-only, rvm-
  loader not on crates.io yet)
- `HOSTS` const in `create-agent-harness` now lists 6 hosts
- README badge added, host table extended with the hardware-isolated tier
- USAGE.md + create-agent-harness/README.md host tables updated
- Topics updated on GitHub

### Added — Iter 11 (2026-06-13)

- **Fifth host adapter: `@ruflo/host-openclaw`** for
  [OpenClaw](https://github.com/openclaw/openclaw) — "Personal AI Assistant.
  Any OS. Any Platform. The lobster way. 🦞"
  - Generates `openclaw.json` (JSON, not TOML/YAML) snippet to merge into
    `~/.openclaw/openclaw.json` under `mcp_servers`
  - Generates `SKILL.md` with YAML frontmatter + markdown for the
    workspace skill at `~/.openclaw/workspace/skills/<name>/SKILL.md`
  - Generates idempotent `install-openclaw.sh` runbook:
    `npm install -g openclaw@latest` → `openclaw onboard --install-daemon`
    → merge MCP snippet → drop SKILL.md in workspace
  - YAML-safe quote escaping in skill description
  - 16 new TS test cases covering serverToOpenClaw stdio/url/env,
    configJson shape + valid-JSON + trailing-newline, skillMarkdown
    frontmatter + quote escaping + agent listing, installScript shebang
    + onboard cmd + workspace path, adapter export contract
- `HOSTS` const in `create-agent-harness` now includes `openclaw` (5 total)
- README, USAGE.md, package READMEs updated with `openclaw` row
- OpenClaw badge added to README header
- Comparison table in `host-openclaw/README.md` highlights what's
  different from the other four adapters (only host with built-in
  multi-platform messaging WhatsApp/Telegram/Slack/Discord)

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
