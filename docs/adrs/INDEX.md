# agent-harness-generator — ADR Index

> Read top-to-bottom. The series is structured so that earlier ADRs ground the later ones; if you jump in the middle you will hit forward references that have not yet been justified.

## How to read this set

Each ADR is independently reviewable. The early series (ADR-001…019) is design documentation the repo is built against; the later, `Accepted` ADRs (e.g. ADR-019 release orchestration, ADR-020/021 the web UI) document decisions whose code has already landed. The naming convention is `ADR-NNN-kebab-case-slug.md` with three-digit padding.

Every ADR follows the same shape:

1. **Title / Status / Date / Related**
2. **Context** — what problem we are solving and why now
3. **Decision** — what we are doing about it
4. **Consequences** — what changes, what does not, what hurts
5. **Alternatives Considered** — what we rejected and why
6. **Test Contract** — what tests must exist for this decision to be considered shipped (London-school for kernel units; integration for generator output; contract tests for host adapters)
7. **References** — citations to prior art, papers, ruflo ADRs

## The phases

| Phase | What ships | ADRs that define it |
|---|---|---|
| **0 — Kernel extraction** | `@metaharness/kernel` package (Rust → wasm + NAPI-RS); refactor strategy from ruflo | ADR-001, ADR-002, ADR-002a |
| **1 — Generator MVP** | `npx create-agent-harness <name>` works for Claude Code | ADR-003, ADR-007, ADR-010, ADR-011 |
| **2 — Multi-host** | Codex, pi.dev, Hermes adapters | ADR-004 |
| **3 — Composer** | Interactive agent / skill / plugin picker; `--from-existing` eject mode | ADR-003 §3, ADR-012 |
| **4 — Marketplace publication** | Generator is itself a marketplace plugin; generated harnesses can publish | ADR-005, ADR-009 |
| **5 — Self-evolving + federation** | Learning loop applied to harness-level optimisation; multi-instance federation | ADR-014 |
| **6 — Vertical packs** | Curated bundles (`@metaharness/vertical-legal`, `@metaharness/vertical-trading`, …) | ADR-013 |

ADR-006 (memory + learning) and ADR-008 (drift detection) cut across all phases. ADR-015 (naming) and ADR-016 (migration) are phase-independent.

## The ADRs

| # | Title | Status | One-line summary |
|---|---|---|---|
| [ADR-001](./ADR-001-goals-and-non-goals.md) | Goals and non-goals | Proposed | What the project is, is not, and what success looks like. |
| [ADR-002](./ADR-002-kernel-boundary.md) | Kernel boundary | Proposed | What goes in `@metaharness/kernel`, what is content. The load-bearing decision of the series. Kernel is Rust → wasm + NAPI-RS. |
| [ADR-002a](./ADR-002a-rust-wasm-napi-publishing-pipeline.md) | Rust crate + WASM/NAPI-RS publishing pipeline | Proposed | Cargo workspace layout, multi-target CI matrix, lockstep version contract. Read after ADR-002. |
| [ADR-003](./ADR-003-generator-architecture.md) | Generator architecture | Proposed | How `create-agent-harness` works: templates, renaming, composition. |
| [ADR-004](./ADR-004-host-integration-model.md) | Host integration model | Proposed | Adapter abstraction across Claude Code, Codex, pi.dev, Hermes. |
| [ADR-005](./ADR-005-marketplace-plugin-design.md) | Marketplace plugin design | Proposed | How the generator and its outputs participate in the IPFS plugin registry. |
| [ADR-006](./ADR-006-memory-and-learning-integration.md) | Memory + learning integration | Proposed | How generated harnesses inherit AgentDB + HNSW + ReasoningBank + emergent-time decay. |
| [ADR-007](./ADR-007-ci-guards.md) | CI guards | Proposed | What GitHub Actions gates must pass before generator/harnesses can publish. |
| [ADR-008](./ADR-008-drift-detection.md) | Drift detection | Proposed | Detecting and recovering kernel/template/generated-harness drift. |
| [ADR-009](./ADR-009-anti-slop.md) | Anti-slop | Proposed | Marketplace quality model: smoke tests, signals, reputation, gates. |
| [ADR-010](./ADR-010-tdd-test-contracts.md) | TDD test contracts | Proposed | Test strategy per phase: London-school unit, integration, contract. |
| [ADR-011](./ADR-011-witness-and-provenance.md) | Witness + provenance | Proposed | Ed25519 manifests for generated harnesses (mirrors ruflo ADR-103). |
| [ADR-012](./ADR-012-eject-and-upgrade-strategy.md) | Eject + upgrade strategy | Proposed | How generated harnesses receive kernel updates. Vendored vs peer-dep. Eject mode. |
| [ADR-013](./ADR-013-vertical-packs-publishing.md) | Vertical packs publishing | Proposed | How curated bundles get published, owned, maintained. |
| [ADR-014](./ADR-014-self-evolution-and-federation.md) | Self-evolution + federation (exotic) | Proposed | Learning loop applied at harness level; federated multi-instance harnesses. |
| [ADR-015](./ADR-015-naming-and-branding-policy.md) | Naming + branding policy | Proposed | Independence mode vs powered-by; scope strategy; marketplace tags. |
| [ADR-016](./ADR-016-migration-for-ruflo-users.md) | Migration for existing ruflo users | Proposed | Moving from ruflo to a generated harness without losing memory / patterns / skills. |
| [ADR-018](./ADR-018-rvm-as-deployment-target.md) | RVM as deployment target | Accepted | Use the RVM microhypervisor as the hardware-isolation tier for federation + multi-tenant deployments. |
| [ADR-019](./ADR-019-release-orchestration.md) | Release orchestration | Accepted | `scripts/release.mjs` composes version-bump + preflight + marketplace + dry-run + tag into one command; refuses dirty tree; per-step PASS/SKIP/FAIL gating. |
| [ADR-020](./ADR-020-web-generator-ui.md) | Web generator UI | Accepted | `apps/web-ui` — client-only React/Vite generator. Composes harnesses + Claude skills/agents/commands, live preview, zip download. Renderer ported behaviour-for-behaviour from the CLI; parity test pins it. |
| [ADR-021](./ADR-021-client-side-packaging-and-pages-deploy.md) | Client-side packaging + Pages deploy | Accepted | JSZip + Blob in-browser packaging (deterministic dates); `VITE_BASE` env-driven base path; gated GitHub Pages workflow (unit + e2e before deploy); UI isolated from the kernel workspace. |
| [ADR-022](./ADR-022-mcp-primitive.md) | MCP as a modular, gated, security-first primitive | Accepted | MCP is one selectable primitive (off/local/remote), default-deny. Emits gated `src/mcp/*` + scannable `mcp-policy.json`; `harness mcp-scan` is "npm audit for agent tools"; policy is witness-bound. |
| [ADR-023](./ADR-023-repo-to-harness-importer.md) | Repo → Harness importer | Accepted | Paste a GitHub URL → deterministic file inventory + archetype scoring → editable harness plan. Embeddings recommend, rules generate, tests prove parity; no repo code executed. |
| [ADR-024](./ADR-024-studio-and-verify.md) | Agent Harness Studio + in-browser Verify | Accepted | Four-tab Studio (Repo→Harness / Create harness / Skill·Agent·Command / Verify). `verifyFileMap` validates a dropped zip in-browser — structure + MCP policy + secrets — no upload. |
| [ADR-025](./ADR-025-browser-embeddings-minilm.md) | Browser embeddings (Transformers.js MiniLM) | Accepted | Implements the ADR-023 `semantic` term with optional, lazy, WebGPU/WASM MiniLM (`all-MiniLM-L6-v2`). Injected into the rule-based scorer; rounded for determinism; lexical fallback stays the default so the deploy needs no model. |
| [ADR-026](./ADR-026-cli-repo-analyzer-ruvllm.md) | CLI repo analyzer + ruvllm | Accepted | `harness analyze-repo [path]` — local, analysis-only repo → plan, mirroring the browser core. Opt-in `--embed` via `@ruvector/ruvllm` (deterministic, offline, optionalDependency) with lexical fallback; writes repo-profile.json + harness-plan.json. |
| [ADR-027](./ADR-027-cli-and-web-ui-integration.md) | CLI and Web-UI integration | Accepted | Byte-parity contract between `packages/create-agent-harness/` (CLI) and `apps/web-ui/` (Studio); decoupled release cadence (npm tag-driven vs Pages push-driven); asymmetric-features table; 6 required tests; manifest.meta.surface + meta.kernel_version diagnostics (iter 56). |
| [ADR-028](./ADR-028-skew-detection-and-liveness.md) | Skew Detection and Liveness | Accepted | Two orthogonal axes (skew: informational, liveness: blocking). Single HTTP probe implementation in `healthcheck` delegated to by `release.mjs` preflight (iter 77) and `pages.yml` verify (iter 78). `skewVerdict()` is the one comparator; `manifest.meta.*` + `resolveLocal<X>Version()` is the recipe for adding a new skew axis. JSON-from-text delegation pattern keeps formatter pairs in lockstep. |
| [ADR-029](./ADR-029-cross-language-invariants.md) | Cross-Language Invariants and Defense-in-Depth Catalog Gates | Accepted | 4-layer defense-in-depth catalog gate ordered by failure-surface latency: `healthcheck.catalogCount` (iter 86) → CI `healthcheck` step → `vertical-tour` per-push gate (iter 89) → per-template structural tests. Pattern for any "same count in N languages" invariant: JSON wins ties, TS + Rust extract via regex, healthcheck pins them together. iter-83 drift class shifts from CI-N+2 to pre-push. |
| [ADR-030](./ADR-030-discovery-loop.md) | The Discovery Loop | Accepted | 5-step propagation for every user-facing tool: build → surface in README/skill → catalog in dev-toolkit/plugin.json → discover contextually (Next: block on FAIL only) → test the propagation. iter-90 bundle reached step 4 across iter 90→94. "Next:" block contract: command using user's actual path + URL + reassurance about cost (sanitisation, etc.). Tests pin FAIL has suggestion AND HEALTHY doesn't. |
| [ADR-031](./ADR-031-bundle-json-pattern.md) | The Bundle JSON Pattern | Accepted | Schema-1 envelope for `--bundle` JSON snapshots, evidenced by 3 implementations (iter 90 diag, iter 97 export-config, iter 102 audit). 6 rules: schema/generatedAt/exitCode envelope, mandatory sanitisation with iter-97 canonical regex, errors-are-bundle-formed, exit code follows verdict, text mode unchanged when `--bundle` added, no shared helper at N=3 (revisit at 4). |
| [ADR-032](./ADR-032-host-copilot.md) | GitHub Copilot as a harness host | Implemented (iter 127) | `@metaharness/host-copilot` — the 7th host adapter. Emits `.vscode/mcp.json` (both `servers` + `mcpServers` keys for VSCode 1.99+ AND Claude Code compat). MCP policy layer unchanged. |
| [ADR-033](./ADR-033-host-github-actions.md) | GitHub Actions as a harness host | Implemented (iter 146–147) | `@metaharness/host-github-actions` — headless CI/CD host, the first NON-INTERACTIVE one. Composite action in `.github/actions/<name>/`, workflow YAML in `.github/workflows/<name>.yml`. Default-deny via the workflow `permissions:` block (`permissionsBlock()` maps allow-list → least-privilege GITHUB_TOKEN scopes). 9th host; propagated into HOSTS catalog + bench + web-ui + CI; `metaharness@0.1.5`. |
| [ADR-034](./ADR-034-oia-integration.md) | Open Intelligence Architecture (OIA) Integration | Proposed | OIA (Agentics Foundation, v0.1) is a nine-layer reference architecture for enterprise intelligent systems — not a runtime. Plugs in as a **cross-cutting manifest layer**: every harness optionally emits `.harness/oia-manifest.json` declaring layer alignment and adjacent-standard wiring. Toggle: `oia: 'off' \| 'manifest-only'`. Default-deny MCP posture takes precedence over any future OIA identity claim. Implementation deferred; 4 open questions gating a follow-on ADR (layer names, registry endpoint, identity composition, v1.0 migration). |
| [ADR-035](./ADR-035-product-naming.md) | Product naming — MetaHarness | Accepted | Documents the iter 108→124 naming journey (agentmint → mintagent → openharness → metaharness) and locks down: **brand = MetaHarness**, **npm = `metaharness`** (one-word, unscoped, published iter 124), **library = `@ruvnet/agent-harness-generator`**, **repo = `ruvnet/agent-harness-generator`** (category, unchanged). Rule from iter 117: *before generation = `metaharness`; inside generated harness = `harness`*. Defensive moat: npm's similarity rule blocks `meta-harness` (dashed) from being squatted by anyone else. |
| [ADR-036](./ADR-036-host-opencode.md) | OpenCode as a harness host (8th host) | Implemented (iter 128) | `@metaharness/host-opencode` — sst/opencode is an open-source terminal AI coding agent, MCP-native by design. The **8th host adapter** following the ADR-032 pattern: config-emitter writing `.opencode/opencode.json` + `install.md`. Schema-compatible with ADR-022 MCP — no protocol bridge needed. Default-deny composition: copies `mcp-policy.json` deny rules verbatim into OpenCode's `mcp.permissions.deny` so the harness's posture wins via OpenCode's own enforcement. |
| [ADR-046](./ADR-046-real-install-host-verification.md) | Real-install host verification (caught 3 schema bugs) | Implemented (2026-06-16) | Installed + ran each feasible host runtime against generated harnesses. claude-code (`claude -p`), codex (`codex exec` via OpenRouter), opencode (`opencode run`), github-actions (`act` in Docker) all run; openclaw `config validate` passes. Caught + fixed 3 real schema bugs that schema-shape + live-content checks missed: opencode (`mcp` is a direct map + top-level `permission`, not `mcp.servers`/`mcp.permissions`), openclaw (`mcp.servers.<name>` with `enabled`, no top-level permissions), hermes (`model:`+`agent.personalities`, no name/system_prompt/scrub keys). pi-dev (no clean install), rvm (AArch64 bare-metal), copilot (interactive VSCode) documented as not-locally-runnable. |
| [ADR-045](./ADR-045-cli-scaffold-host-adapter-wiring.md) | CLI scaffold host-config wiring for all 9 hosts | Implemented (2026-06-16) | Found during the ADR-044 live verification: `npx metaharness <name> --host <non-claude>` records the host in the manifest but emits only `.claude/*` config — the CLI scaffolder renders claude-shaped `templates/` and never calls the (now spec-complete) `@metaharness/host-*` adapters. Three host-config codegen paths exist; only the adapters + web-UI cover all 9 hosts. Proposed fix: build a HarnessSpec post-`walkTemplate`, call each host's `generateConfig`, merge; + make `verify-all-hosts.mjs` scaffold via the real `--host` path so it can't silently regress. Deferred (cross-cutting wiring change). |
| [ADR-044](./ADR-044-live-llm-host-verification-and-capability-coverage.md) | Live-LLM host verification & host capability coverage review | Proposed | Closes two gaps found reviewing all 9 `host-*` adapters: (1) `verify-all-hosts.mjs` is schema-only for 8/9 hosts (real `claude -p` only for claude-code) — adds `scripts/verify-harness-live.mjs`, a provider-agnostic live verifier via OpenRouter (`OPENROUTER_API_KEY` GCP secret, ~$0.0002/host, SKIPPED without key); (2) adapters under-consume `HarnessSpec`. Capability matrix + 3 bug-grade findings (opencode permissions read wrong field; opencode drops agents; rvm capability table built from empty array). Drives coverage to 100% via `REVIEW-PROGRESS.md`, CLI hosts first then web-UI. opencode fixed first (iter 1). |
| [ADR-037](./ADR-037-draco-deep-research-benchmark.md) | DRACO — cross-domain deep-research benchmark with OpenRouter fusion | Proposed | The missing quality gate for `vertical:research`. Versioned cross-domain corpus (≥50 Q, machine-checkable rubrics) + OpenRouter fusion harness (each pipeline stage routes to a different model class; a DIFFERENT strong model verifies than synthesises — fusion's point). 5-dimension scoring (grounding via citation re-fetch, coverage, balance, LLM-judge faithfulness, efficiency). Proof = committed re-runnable `runs/<iso>.json` + per-domain breakdown; `bench-baseline` regression gate. `OPENROUTER_API_KEY` via the iter-145 GCP secret-list gate. 6 horizon-tracked milestones (M1 corpus → M6 fusion-vs-single ablation). Owned by `ruflo-goals:horizon-tracker`. |
| [ADR-047](./ADR-047-algorithmic-agent-harness.md) | The Algorithmic Agent Harness — algorithms as the control plane | Proposed | `@metaharness/harness` — a dependency-free, deterministic control plane that wraps any model/tool/skill as a replaceable **worker**. Composes the series' pieces (router ADR-040/043, receipts ADR-011, MCP gating ADR-022, learning ADR-014) into the 10-step execution loop. Key invariant: `decision = argmax utility(action)`; no action runs unless `confidence ≥ threshold ∧ risk ≤ budget ∧ cost ≤ budget ∧ verification == pass`. One algorithm per module (softmax intent router · UCB1 bandit pool · adversarial verifier + critique loop · default-deny policy gate · circuit breaker + retry budget · weighted-majority/Borda consensus · hash-chained tamper-evident receipts). 44 unit tests; "the model proposes, the harness decides, the algorithms verify." |

## Conventions used across the series

- **"Kernel"** = `@metaharness/kernel`, the package extracted from ruflo that contains primitives a harness needs regardless of identity or content (MCP wiring, hooks runtime, memory bridge, routing). Defined in ADR-002.
- **"Harness"** = a generated, npm-publishable package that wraps the kernel with chosen content (agents, skills, plugins) and identity (name, brand, scope). Defined in ADR-001.
- **"Content"** = agents, skills, prompts, plugins, vertical-specific code. Lives in the harness, not the kernel. Defined in ADR-002.
- **"Host"** = the agentic CLI or platform that runs the harness (Claude Code, Codex, pi.dev, Hermes). Defined in ADR-004.
- **"Composer"** = the interactive picker in `create-agent-harness` that lets a user choose agents, skills, plugins, primitives. Defined in ADR-003.
- **Powered-by**: a generated harness that ships kernel as a peer dep and links back to ruflo branding. Default mode.
- **Independence**: a generated harness that vendors the kernel (or hard-forks it) and ships under its own brand. Alternative mode. Defined in ADR-015.

## How to amend this series

- Edits to a Proposed ADR happen in PRs that reference the ADR number.
- A ratified ADR (`Status: Accepted`) is amended by a follow-on ADR (`Status: Supersedes ADR-NNN`) and never edited in place.
- New ADRs append to the series — they do not renumber.
- Cross-references between ADRs use the ADR number, not the slug, so renames do not break links.

## What to do next

If you are reading this with intent to start implementation, the gating ADR is **ADR-002 (Kernel boundary)**. Until that is accepted, every subsequent phase is blocked. ADR-002 is the highest-priority review.
