# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — Iter 32 (2026-06-13)

- **`examples/quickstart/`** — first RUNNABLE example. Before this iter
  the `examples/` directory had three READMEs but no executable code.
  Now there's a single-script demo:
  - `node examples/quickstart/quickstart.mjs` — scaffolds a `demo-bot`
    harness from the `minimal` template, runs the full `harness validate`
    umbrella against the output, prints a summary, cleans up. ~50ms.
  - Flags: `--host=<id>` (any of 6 hosts), `--template=<id>`,
    `--name=<n>`, `--keep` (don't auto-clean).
  - Imports from the built `dist/` — no TS toolchain needed at runtime.
  - Locally verified on all 6 hosts (50–55ms each):
    `claude-code, codex, pi-dev, hermes, openclaw, rvm`.
- **`examples/README.md` rewritten** to lead with the quickstart and
  signal `runnable? yes` vs the docs-only multi-host + federation
  examples.
- **`__tests__/examples-quickstart.test.ts`** (4 cases) — pins the
  example as code that must keep running, not docs that nobody verifies:
  - script + README exist
  - default run exits 0 with `Result: HEALTHY`
  - invalid `--host` exits 2 with explanatory error
  - smoke-runs all 6 hosts (one assertion per host)
- CI milestone: iter-31 commit `b37060c` ran with **all 16 jobs GREEN**
  for the first time (Rust×3 + WASM×3 + Node20+22×3 + Bench + pack+install×3
  + CI-passed aggregator). The iter-31 batch-install fix unblocked the
  last 2 pack-install jobs.
- TS suite: **345/345** (up from 341).

### Fixed — Iter 31 (2026-06-13)

- **CI `pack+install` job RED on macos+windows since iter 16** —
  installing each tarball individually meant npm tried to resolve the
  cross-tarball `@ruflo/*` deps from the registry, where they don't
  exist pre-publish. Real CI error: `npm error 404 Not Found - GET
  https://registry.npmjs.org/@ruflo%2fkernel - Not found` ×7 of the
  11 packages. This was masking real install regressions because every
  host adapter failed in the same way.
- **Fix**: rewrote `scripts/install-all.mjs` to do a single batched
  `npm install <t1.tgz> <t2.tgz> ... <tN.tgz>` call. npm now resolves
  `@ruflo/*` deps from the OTHER tarballs in the same install set,
  not the registry. Then a second pass spot-checks each installed
  package's `package.json` is present under `node_modules/<scope>/<name>/`.
- **Verified locally**: 11/11 packages install cleanly (was 4/11
  before the fix). Includes the cross-deps (`host-rvm` finds its
  `@ruflo/kernel`, `vertical-trading` finds its `@ruflo/vertical-base`,
  `create-agent-harness` finds its `@ruflo/kernel`).
- This is the regression class iter 16's pack-install job was
  designed to catch — and now actually does.

### Added — Iter 30 (2026-06-13)

- **e2e validate-per-host sweep** added to
  `__tests__/e2e-scaffold-validate.test.ts`. Iter 23's "scaffolds for
  every host" only checked the scaffolder didn't throw — this new case
  runs the full `harness validate` umbrella against the output of every
  host (claude-code / codex / pi-dev / hermes / openclaw / rvm).
  Catches host-specific artifact regressions: a host adapter that emits
  a malformed `.codex/config.toml`, a host-specific MCP config that
  fails the iter-20 mcp check, etc. — without needing a host-specific
  test suite for each.
- **`__tests__/workflows.test.ts`** (7 cases) — `.github/workflows/*.yml`
  structural validation. Catches the silent-CI-drift bugs that
  actionlint would catch, but as part of the same vitest run:
  - no tab-indented YAML lines (causes parse errors only on some
    parsers)
  - every `node scripts/<X>.mjs` reference points at a real file
    (catches script renames that miss the workflow)
  - unique job names per workflow
  - ci.yml matrix runs every gate on all 3 OS
  - publish.yml runs **both gates** (`validate-gcp-secrets.mjs` +
    `publish-dryrun.mjs`) BEFORE any `npm publish --provenance`
  - publish.yml runs `marketplace-entry.mjs` AFTER the final
    `npm publish`
  - publish.yml has a step for every 6-host adapter package
- These two together close the loop: the validate umbrella is now
  asserted to work per-host, AND the publish workflow is asserted to
  invoke it in the right order. Future workflow drift fails CI before
  it ships.
- TS suite: **341/341** (up from 333).

### Added — Iter 29 (2026-06-13)

- **`scripts/version-bump.mjs`** — atomic cross-package version sync.
  Bumps EVERY `package.json` under the repo (root + 12 workspace packages
  + `.claude-plugin/plugin.json`) plus `Cargo.toml`'s
  `[workspace.package].version` in a single deterministic pass. The
  existing `preflight.mjs` already catches version drift across packages
  — this script makes the inverse (synchronised bump) a one-command op.
  - `node scripts/version-bump.mjs patch|minor|major|<x.y.z>`
  - `--dry-run` for safe diff preview
  - Workspace deps to other `@ruflo/*` packages get bumped in lockstep
    (so `host-rvm` → `@ruflo/kernel ^0.1.0` becomes `^0.1.1` together)
- **`__tests__/version-bump.test.ts`** (7 cases) — pins the cross-pack
  lockstep invariant inside a tmpdir fixture so the test is fully
  hermetic:
  - patch / minor / major / explicit-version bumps
  - workspace deps to other `@ruflo/*` packages updated in lockstep
  - `--dry-run` doesn't touch files
  - rejects unparseable target with non-zero exit
- CI milestone: iter-28 commit `7b9bbcf` ran with all 12 core matrix
  jobs GREEN — **second consecutive iter at full green**.
- TS suite: **333/333** (up from 326).

### Added — Iter 28 (2026-06-13)

- **Marketplace entry generation + IPFS pin wired into `publish.yml`**
  — completes the marketplace publishing pipeline as an actual,
  load-bearing CI step:
  1. After all 11 npm packages publish successfully…
  2. `node scripts/marketplace-entry.mjs` regenerates
     `dist/marketplace-entry.json` from live `.claude-plugin/plugin.json`
     and root `package.json`.
  3. Fetches `PINATA_JWT` from GCP Secret Manager (best-effort —
     `continue-on-error: true`; first-time releases skip cleanly).
  4. Single-file POST to Pinata's `pinFileToIPFS` endpoint, extracts
     the `IpfsHash`, surfaces it as a `::notice::` annotation + step
     output `marketplace_cid` for downstream registry-update workflows.
  5. Pin failure is non-fatal — the npm publish has already succeeded.
- **5th Codex skill: `verify-witness`** — distinct from the iter-22
  `validate-harness` umbrella because it only checks the Ed25519
  signature:
  - Use case: federation handshake / multi-signer workflow / CI mirror
    where you don't need the full release-readiness sweep.
  - Args: `path` (default `.`), `strict` (default `true` — fail if no
    witness; soft-skip when `false`).
  - `.codex/skills/verify-witness/skill.toml` + `README.md` follow the
    schema the iter-22 cross-skill test pins.
- **`.claude-plugin/plugin.json`** updated to list `verify-witness` as
  the 5th skill + 5th command (otherwise the iter-24 orphan-skill check
  would flag the new directory).
- Codex skill catalog now: **create / publish / validate / secrets /
  verify-witness** — 5 surfaces.
- Cumulative test suite: 326/326 (verify-witness + the marketplace
  pipeline already had test coverage from iter 22 + 27).

### Added — Iter 27 (2026-06-13)

- **`scripts/marketplace-entry.mjs`** — turns `.claude-plugin/plugin.json`
  into the marketplace-registry JSON that gets pinned to IPFS and
  discovered by other agents. Mirrors the shape of
  `v3/@claude-flow/cli/src/plugins/store/discovery.ts` so the same
  browsing UI consumes it without modification. Modes:
  - `--print` (stdout, for piping into `pinata pin file -`)
  - `--validate` (validate-only; no file written)
  - default (writes `dist/marketplace-entry.json`)
- **`buildMetaEntry()` + `validateEntry()`** — exported from the script
  for programmatic use (and the new test). Witness signature + IPFS
  CIDs are optional fields the publish pipeline fills in.
- **`__tests__/marketplace-entry.test.ts`** (6 cases) — pins the entry
  shape against the live plugin.json:
  - well-formed entry from live data
  - skills match iter-22 (`create-harness, publish-harness,
    validate-harness, harness-secrets`) — catches codex↔marketplace
    drift in either direction
  - tags include 6-host catalog (`openclaw`, `rvm`, `claude-code`)
  - witness/ipfs slots present only when input provides them
  - rejects too-short descriptions (<30 chars)
  - `validateEntry()` catches missing required fields
- **CI milestone**: iter-26 commit `ae99075` was the FIRST run where
  all 12 jobs went green simultaneously (Rust×3 + WASM×3 + Node20+22×3).
  The path-guard fix unblocked the Node lane.
- TS suite: **326/326** (up from 320).

### Fixed — Iter 26 (2026-06-13)

- **path-guard scanner was finding itself** — the Node CI jobs had
  been failing since iter 20 once the build-ordered fix (iter 24)
  exposed them. Root cause: `scripts/path-guard.mjs` is the scanner
  that flags hardcoded `/tmp/`, `C:\`, `/Users/`, `/home/` references,
  but it itself contains those very strings as the regex literals it's
  scanning for. Same for `packages/create-agent-harness/src/validate.ts`
  (iter 20's path-guard sub-check embeds the same regex) and
  `crates/kernel/src/hooks.rs` (test fixture `Bash(rm -rf /tmp)`).
  CI: 11 self-flagged regressions per run.
- **Fix**: added a `SKIP_FILES` set listing the three known-meta paths:
  - `scripts/path-guard.mjs` (the scanner)
  - `packages/create-agent-harness/src/validate.ts` (the umbrella that
    embeds the same regex)
  - `crates/kernel/src/hooks.rs` (the hook-matcher fixture)
- After the fix: `path-guard: clean (scanned packages, crates, scripts
  on win32)`. Real regression detection still works — only these three
  specific meta-files are exempt.

### Added — Iter 25 (2026-06-13)

- **`__tests__/pack-contents.test.ts`** (6 cases) — `npm pack --dry-run
  --json` on every package, then asserts the tarball CONTAINS the files
  README + exports promise:
  - `@ruflo/kernel` ships README + LICENSE + `dist/`
  - every host adapter (×6) ships README + LICENSE + `dist/`
  - `create-agent-harness` ships `dist/`, `templates/`, AND both bin
    entrypoints (`dist/bin.js`, `dist/harness-bin.js`) — the exact
    bug class that hit create-agent-harness@0.1.0 when npm auto-
    corrected the broken bin paths
  - vertical packs ship `dist/`
  - `@ruflo/sdk` ships `dist/` + README
  - NO package leaks `.env`, `node_modules`, `.tsbuildinfo`,
    `.DS_Store` (a separate regression class — accidental secret /
    bloat in a tarball)
- **Real bug caught immediately**: the test found that **all 10
  publishable packages (the 6 host adapters + kernel + sdk + 2
  verticals) were shipping WITHOUT LICENSE files**. This is an MIT
  license-text-must-accompany-the-code violation that would have
  hit the registry on first publish. The root `LICENSE` was the
  only one in the repo.
- **Fix**: copied root `LICENSE` to all 10 publishable package
  directories. Test now passes 6/6.
- TS suite: **320/320** (up from 314).

### Added — Iter 24 (2026-06-13)

- **`__tests__/claude-marketplace-plugin.test.ts`** (8 cases) — pins
  the shape of `.claude-plugin/plugin.json` so future host/skill drift
  fails CI before installs break silently:
  - field-by-field required-field check against marketplace schema
  - every `commands[i]` has kebab-case `name` + ≥10-char `description`
  - every `skills[]` entry has a backing `.codex/skills/<name>/` dir
  - every `.codex/skills/` directory is referenced from `plugin.json`
    (no orphans either way)
  - tags include every supported host (catches host-add drift —
    iter-12 added `rvm` and it took until now to land in plugin.json)
  - `skills.length` matches `.codex/skills` dir count exactly
- **`.claude-plugin/plugin.json` rewritten** to reflect current state:
  - 6-host description (was 4)
  - tags: added `openclaw`, `rvm`, `ed25519`, `witness`,
    `gcp-secret-manager` (5 new keywords for marketplace discoverability)
  - skills: dropped non-existent `list-templates`, added `validate-harness`
    + `harness-secrets` from iter 22
  - commands: now 4 entries (was 2), all backed by real codex skills

### Fixed — Iter 24 (2026-06-13)

- **Node CI jobs red on iter-23** (build failed across all 4 node jobs):
  - `npm run -ws --if-present build` runs the workspace builds in
    undefined order, and `tsc` in `host-rvm` runs BEFORE `kernel-js`
    produces `dist/index.d.ts` — failure: "Cannot find module
    `@ruflo/kernel`".
  - Replaced root `build` script with `scripts/build-ordered.mjs`,
    a 4-phase topological build:
      1. `kernel-js` (everyone depends on it)
      2. `vertical-base` (vertical-trading depends on it)
      3. all hosts + sdk + cli + bench (parallel-safe)
      4. `vertical-trading`
- **`kernel-js/src/index.ts:48`** — `import('../pkg/ruflo_kernel_wasm.js')`
  is wasm-pack output that doesn't exist on a TS-only checkout. Added
  `@ts-ignore`; the runtime gracefully falls back to NAPI when the
  dynamic import fails.
- **`kernel-js/src/memory-rvf.ts:50`** — `@ruvector/rvf` is an OPTIONAL
  peer dep. Added `@ts-ignore` so a fresh install without it builds
  cleanly (already had runtime fallback).
- **`scripts/publish-dryrun.mjs`** — `execFile` of `npm.cmd` on Windows
  with `shell: true` triggers Node 22's DEP0190 deprecation. Switched
  to `cmd.exe /d /s /c npm …` invocation; same behaviour, no warning.

### Added — Iter 23 (2026-06-13)

- **End-to-end integration test**
  (`__tests__/e2e-scaffold-validate.test.ts`) — 4 cases that walk the
  scaffolder → validate pipeline without mocks. This is the strongest
  cross-iter regression net we have; if any of these layers breaks,
  the test fires before publish:
  - `minimal/claude-code scaffolds, then 'harness validate' reports
    HEALTHY` — exercises scaffolder (iter 4), witness shape (iter 3+8),
    path-guard (iter 16), MCP config (iter 8), validate umbrella
    (iter 20) in one chain
  - `scaffolds for every host without throwing` — runs the scaffolder
    against all 6 hosts (claude-code / codex / pi-dev / hermes /
    openclaw / rvm); the previous codex-skills test only catches
    catalog drift, this catches actual generator regressions per-host
  - `scaffold output passes path-guard` — pins that the SCAFFOLDER
    itself doesn't emit hardcoded `/tmp/`, `C:\`, `/Users/` paths —
    if it did, every user-generated harness inherits the original
    iter-1 /tmp Windows bug
  - `subsequent scaffold with same name and force=true is idempotent` —
    catches non-deterministic generation (timestamps in templates,
    Math.random etc.) that would break drift detection
- TS suite: **306/306** (up from 302).
- CI on iter-22 commit: WASM-windows turned green for the first time —
  the iter-18 wasm-pack 0.13.1 + wasm-tools 1.250.0 pins worked.

### Added — Iter 22 (2026-06-13)

- **2 new Codex skills** that surface iter-18 and iter-20 features to
  Codex installations (`.codex/skills/<name>/{skill.toml,README.md}`):
  - **`validate-harness`** — wraps `harness validate`; runs all 5
    release-readiness gates (doctor + verify + path-guard + mcp +
    secrets) and reports per-check PASS/FAIL
  - **`harness-secrets`** — wraps `harness secrets`; modes are
    `check` (validate GCP setup), `fetch` (pipe secret value), and
    `validate-token` (fetch NPM_TOKEN + `npm whoami` confirm)
- **`create-harness` skill expanded to all 6 hosts** — previously the
  `host` arg only listed `claude-code, codex, pi-dev, hermes`. Added
  `openclaw` and `rvm` so Codex users see the full host catalog.
- **`publish-harness` README** added (it was the only skill missing one
  — the cross-skill test caught it).
- **`__tests__/codex-skills.test.ts`** (6 cases) — schema validation
  for every `.codex/skills/*/skill.toml`. Pins:
  - ≥4 skill directories present
  - both `skill.toml` + `README.md` per skill
  - required fields: `[skill].name|version|description`,
    `[dispatch].type=mcp_tool|server`, `[command].name`
  - dir name == `[skill].name` == `[command].name`
  - per-`[[args]]`: `name` + `prompt` present
  - the 4 expected skills (create / publish / validate / harness-secrets)
  - create-harness lists all 6 hosts
- Cumulative TS suite: **302/302** (up from 296).

### Added — Iter 21 (2026-06-13)

- **Wired the publish gates into `.github/workflows/publish.yml`** —
  iters 18 + 20 built `validate-gcp-secrets.mjs` and `publish-dryrun.mjs`
  but they weren't actually called by CI. Now both are mandatory gates
  in the publish job, running after smoke tests but before any
  `npm publish`:
  - **Gate 1**: `node scripts/validate-gcp-secrets.mjs` — re-verifies
    WIF → Secret Manager → `npm whoami` chain on the live runner.
    If anything has drifted between the last successful publish and
    now, the publish aborts BEFORE registry I/O.
  - **Gate 2**: `node scripts/publish-dryrun.mjs` — dry-runs every
    package's publish, exits non-zero if any package would fail
    (broken `files`, missing `bin`, unresolvable workspace ref).
- **Added `setup-gcloud@v2` step** before the gates — the WIF auth
  action sets ADC but doesn't install the SDK, and Gate 1 shells out
  to `gcloud secrets describe`.
- **Per-package publish steps for all 11 workspace packages** (was 2):
  - `@ruflo/kernel` (umbrella)
  - `@ruflo/sdk`
  - 6 host adapters (`host-claude-code`, `host-codex`, `host-pi-dev`,
    `host-hermes`, `host-openclaw`, `host-rvm`)
  - 2 vertical packs (`vertical-base`, `vertical-trading`)
  - `create-agent-harness`
- **`docs/RELEASE.md` updated** with the two new gates and the 11-package
  publish list, plus the rationale: this is the "validation using keys
  from gcp secrets" directive realised as an actual pipeline.

### Added — Iter 20 (2026-06-13)

- **`harness validate` umbrella command** — single release-readiness
  gate that fans out to 5 sub-checks and reports per-check PASS/FAIL:
  - `doctor`     — file-shape + manifest hash + ≥1 host artifact
  - `verify`     — witness manifest signature (skipped if no witness)
  - `path-guard` — TS/JS/Rust files scanned for hardcoded `/tmp/`,
                   `C:\`, `/Users/`, `/home/` (the original Windows
                   /tmp bug regression class)
  - `mcp`        — `.mcp/servers.json` (if present) has `name` +
                   `command` on every entry
  - `secrets`    — `gcloud auth list` + project + secret exist (or
                   skip with `--skip-gcp`)
  - 7 tests cover the umbrella + each check independently.
- **`scripts/publish-dryrun.mjs`** — runs `npm publish --dry-run --json`
  on every non-private workspace package and reports per-package
  PASS/WARN/FAIL with file count + unpacked size. Detects the
  "version already published" case as WARN rather than FAIL so the
  publish gate doesn't block on version-not-bumped. Handles npm's
  `npm.cmd` vs `npm` Windows quirk via per-platform shell:true.
  Validates all 11 packages locally with 10 PASS / 1 WARN / 0 FAIL.

### Fixed — Iter 19 (2026-06-13)

- **4 pre-existing test failures green'd** (`memory.rankWithDecay` and
  3 `SelfEvolvingRouter` tests):
  - `loadEmergent` in both `memory.ts` and `self-evolution.ts` used to
    consider `@ruvector/emergent-time` "available" as soon as the JS
    shim dynamically imported. But the WASM bindings need explicit
    `init()` before constructors work — the shim loads, the dynamic
    import resolves, and then `new emergent.AgenticClock(...)` throws
    `Cannot read properties of undefined (reading 'agenticclock_new')`.
    Probe-construct + discard inside `loadEmergent` catches that case
    and returns null so callers see a consistent "graceful absent"
    signal. Same pattern for `LearnedWeights` (also guards against
    upstream API drift).
  - `SelfEvolvingRouter` EMA fallback used `reward` directly as the
    EMA target. Since `computeReward` returns [0, 1] and the initial
    weight is 1.0, ALL touched tiers drifted below initial — meaning
    untouched tiers ALWAYS won re-ranking. Fixed by mapping the target
    to `reward * 2`, so 0.5 (neutral reward) maps to 1.0 (initial),
    successes pull above, failures below. The previously-failing
    "rewards successful tier" test now passes deterministically.
- TS suite: **289/289 passing** (up from 259/263).

### Added — Iter 18 (2026-06-13)

- **`harness secrets` subcommand** — long-requested GCP Secret Manager
  integration delivered as `harness secrets <check|fetch|validate-token>`:
  - `check` validates the full setup (gcloud on PATH, active project,
    auth principal, secret exists, WIF pool present)
  - `fetch <name>` prints a secret value to stdout (for `eval`/pipe use)
  - `validate-token` fetches `NPM_TOKEN` and runs `npm whoami` against
    the registry — no publish, just confirms the token is non-revoked
  - Common flags: `--project=<id>`, `--secret=<name>`, `--version=latest`
  - Shells out to `gcloud` (already a documented prereq) rather than
    pulling in `@google-cloud/secret-manager` (12 MB dep). 8 unit tests
    cover the mock-gcloud paths.
- **`scripts/validate-gcp-secrets.mjs`** — standalone pre-publish gate
  for `.github/workflows/publish.yml`. Runs 6 fail-fast checks before
  any `npm publish` and exits non-zero with structured `[gcp-validate]
  PASS/FAIL/WARN/INFO` lines that CI can grep on.

### Fixed — Iter 18 (2026-06-13)

- **CI WASM-windows broken** — `cargo install wasm-pack --locked`
  pinned to 0.15.0 whose lockfile pulls `cargo-platform 0.3.3` requiring
  rustc 1.91+. Pinned `wasm-pack 0.13.1` (rustc-1.74 compatible).
  Defensively pinned `wasm-tools 1.250.0` so future MSRV bumps don't
  silently break the matrix again.
- **`packages/host-rvm/src/index.ts:166` syntax error masked by
  `.replace()` hack** — the `lifecycle = "managed"` line opened with a
  backtick but closed with a single quote (`` `…"managed"');``). esbuild
  refused to transform the file, which silently dropped 26 tests from
  the suite. Removed the `.replace()` post-process and fixed the
  template literal properly. The 26 host-rvm tests now actually run.

### Fixed — Iter 17 (2026-06-13)

- **CI red on `e8d5b77` (iter 16) — all 3 OS Rust + WASM jobs failing.**
  Root causes + fixes (commit `f7245cc`):
  - `rust-toolchain.toml` pinned to **1.83.0** (Nov 2024). `wasm-tools
    1.252.0` + current `wasm-pack` need 1.85+. Bumped to **1.88.0**
    (latest stable as of 2025-06-26).
  - Workspace `rust-version` 1.75 → 1.85 (kernel-napi build script
    uses 1.77+ `cargo::` instruction syntax).
  - `cargo fmt --all` re-ran with 1.88 — 11 files reformatted.
  - 52 `missing_docs` errors on stub APIs (1.85+ tightened the check):
    removed from crate-wide warn, kept `rust_2018_idioms`.
  - `napi` crate needed `serde-json` feature for `serde_json::Value`
    return values.
  - `clippy::uninlined_format_args` fix in `witness_sign` bench.
  - Verified locally: fmt clean, clippy -D warnings clean, all tests pass.

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
