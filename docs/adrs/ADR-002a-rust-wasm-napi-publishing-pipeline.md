# ADR-002a: Rust Crate + WASM / NAPI-RS Publishing Pipeline

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-002 (Kernel boundary), ADR-006 (Memory + learning, the emergent-time consumption), ADR-007 (CI guards, the publish-time matrix), ADR-011 (Witness, the determinism rationale)

> This ADR is part of the kernel decision, split from ADR-002 for depth. ADR-002 specifies WHAT lives in the kernel and WHY it ships as Rust → wasm + native. This ADR specifies HOW the Cargo workspace is laid out, HOW the publishing matrix is wired, and WHICH gates protect the lockstep version contract between `@metaharness/kernel` and the per-platform `@metaharness/kernel-<platform>` packages.
>
> Read this after ADR-002.

## Distribution amendment — 2026-10-27

The five declared native packages at version 0.1.0 currently return 404 from the public npm registry. npm 11 rejects clean installs whose lockfile cannot resolve those optional dependencies. Until real native artifacts are published, source manifests declare them as optional peers: explicit installations remain discoverable by the unchanged native loader, followed by wasm and the JavaScript fallback. Native packages are not automatically installed in this interim state. Private benchmarks use compatible workspace adapter ranges rather than old registry-only adapter pins. Restore `optionalDependencies` only after published-platform and clean-install qualification. Existing published kernel manifests remain unchanged; they require a separate versioned release to receive this correction.

## Context

ADR-002 commits the kernel to two distribution targets: a WebAssembly bundle for cross-platform reach (browser, Cloudflare Workers, Deno, Bun, Node, edge) and per-platform native NAPI-RS binaries for Node hosts that want to skip the wasm cost. The kernel is one Rust workspace; the npm surface is one umbrella package (`@metaharness/kernel`) plus five-to-six per-platform peer packages declared as `optionalDependencies`.

This ADR exists because the publishing pipeline is non-trivial and load-bearing:

- The version-pin contract between the umbrella and each native peer must hold at every publish; any skew breaks the runtime loader.
- The wasm bundle must pass `wasm-tools validate` and stay under a size budget (regressions in size add measurable cold-start latency).
- The native peers must build for at least the five most-used Node deployment targets (macOS arm64, macOS x64, Linux x64 glibc, Linux x64 musl, Windows x64). Linux arm64 is on the second tier.
- The smoke test contract for both targets must run from a clean install in a tmpdir, not against the in-tree build.
- `@ruvector/emergent-time@0.1.0` is the working precedent for the wasm half of this pipeline. It is already shipping. We should not reinvent the working parts.

## Decision

### Cargo workspace layout

```
ruvnet/agent-harness-generator/
  crates/
    kernel/                  # Rust kernel — the substrate. Pure-rust crate. No JS bindings.
      Cargo.toml             # [lib] crate-type = ["rlib"]
      src/
        mcp/
        hooks/
        memory/
        routing/
        marketplace/
        witness/
        init/
        hosts/
        lib.rs               # re-exports the eight subsystems
    kernel-wasm/             # wasm-bindgen wrapper around `kernel`. Cdylib.
      Cargo.toml             # [lib] crate-type = ["cdylib"]; deps: kernel, wasm-bindgen
      src/lib.rs             # wasm_bindgen exports for each subsystem
    kernel-napi/             # NAPI-RS wrapper around `kernel`. Cdylib.
      Cargo.toml             # [lib] crate-type = ["cdylib"]; deps: kernel, napi, napi-derive
      src/lib.rs             # #[napi] exports for each subsystem
  npm/
    kernel/                  # @metaharness/kernel — the umbrella npm package
      package.json
      loader.js              # runtime triage: prefer native, fall back to wasm
      pkg/                   # populated by wasm-pack (gitignored, built in CI)
        kernel_bg.wasm
        kernel.js
        kernel.d.ts
        ...                  # one .d.ts per subsystem
    kernel-darwin-arm64/     # @metaharness/kernel-darwin-arm64 — populated by napi build
      package.json
      kernel.darwin-arm64.node
    kernel-darwin-x64/
    kernel-linux-x64-gnu/
    kernel-linux-x64-musl/
    kernel-linux-arm64-gnu/
    kernel-win32-x64-msvc/
```

The `crates/kernel/` is a pure-rust library with **no** JS bindings — that keeps the core easy to unit-test, easy to use from any other Rust consumer, and free of `wasm_bindgen` / `napi` macro pollution. The `kernel-wasm/` and `kernel-napi/` crates are thin wrappers (cdylib) that re-export the kernel surface with the target-specific binding attributes. Both wrappers share the same internal kernel; if the kernel passes its tests, the wrappers' surfaces are mechanically derived.

The `kernel-wasm` and `kernel-napi` cdylibs are **excluded from the default workspace** in the root `Cargo.toml` (`[workspace] exclude = ["crates/kernel-wasm", "crates/kernel-napi"]`) so `cargo build` at the workspace root does not try to compile them for the host triple. This is the same pattern `@ruvector/emergent-time` used to keep its cdylib out of the workspace shards.

### Build pipeline

#### Wasm track

```
cargo build --target wasm32-unknown-unknown -p kernel-wasm --release
  → wasm-pack build crates/kernel-wasm --target bundler --release --out-dir ../../npm/kernel/pkg
    → wasm-opt -Oz npm/kernel/pkg/kernel_bg.wasm -o npm/kernel/pkg/kernel_bg.wasm
      → wasm-tools validate npm/kernel/pkg/kernel_bg.wasm
        → npm/kernel/pkg/ is now ready for publish
```

References:
- `wasm-pack` — https://rustwasm.github.io/docs/wasm-pack/
- `wasm-bindgen` — https://rustwasm.github.io/docs/wasm-bindgen/
- `wasm-opt` (binaryen) — https://github.com/WebAssembly/binaryen
- `wasm-tools` — https://github.com/bytecodealliance/wasm-tools

Output guarantee (matching the `@ruvector/emergent-time@0.1.0` precedent):
- `pkg/kernel_bg.wasm` — wasm-opt'd, validates clean, loadable via `initSync()` in Node / bundler / browser.
- `pkg/kernel.js` — the generated loader JS.
- `pkg/*.d.ts` — TypeScript types, auto-generated from `wasm_bindgen` annotations, `tsc --strict` clean.

#### Native track

```
For each target triple in {darwin-arm64, darwin-x64, linux-x64-gnu, linux-x64-musl, linux-arm64-gnu, win32-x64-msvc}:
  napi build --platform --release --target <triple> -p kernel-napi
    → produces kernel-napi/kernel.<triple>.node
    → copy to npm/kernel-<triple>/kernel.<triple>.node
```

Reference: NAPI-RS — https://napi.rs/

Output guarantee:
- One `.node` file per platform.
- `package.json` declares the matching `os` and `cpu` fields so npm refuses to install the wrong binary.
- `tsc --strict` clean against the same generated `.d.ts` the wasm track produces.

### Runtime resolver (`npm/kernel/loader.js`)

The umbrella package's entry point is `loader.js`. It tries to load the native binary that matches the current platform; on failure (Cloudflare Workers, browser, an unsupported triple, an air-gapped install that did not fetch the native peer), it falls back to the wasm bundle.

Sketch (full implementation in `npm/kernel/loader.js`):

```js
let nativeBinding;
try {
  const platform = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
  nativeBinding = require(`@metaharness/kernel-${platform}`);
  if (nativeBinding.__VERSION !== require('./package.json').version) {
    throw new Error(`@metaharness/kernel version skew: umbrella ${require('./package.json').version}, native ${nativeBinding.__VERSION}`);
  }
} catch (err) {
  // Fall back to wasm
  const wasm = require('./pkg/kernel.js');
  nativeBinding = wasm;
}
module.exports = nativeBinding;
```

The version-skew throw is intentional. If the umbrella and the native peer ship at different versions (a partial publish, a tampered install), the loader fails closed rather than silently mounting incompatible binaries. The version check is the first line of defence for the lockstep contract.

### CI publishing matrix

Publishing runs from a single GitHub Actions matrix workflow. One run produces all artefacts; the publish step is a transactional batch.

```yaml
# .github/workflows/publish-kernel.yml (sketch)
name: publish-kernel
on:
  push:
    tags: ['kernel-v*']

jobs:
  build-wasm:
    runs-on: ubuntu-latest
    outputs:
      pkg-tarball: <path>
    steps:
      - run: cargo install wasm-pack
      - run: wasm-pack build crates/kernel-wasm --target bundler --release --out-dir ../../npm/kernel/pkg
      - run: wasm-opt -Oz npm/kernel/pkg/kernel_bg.wasm -o npm/kernel/pkg/kernel_bg.wasm
      - run: wasm-tools validate npm/kernel/pkg/kernel_bg.wasm
      - run: ./scripts/check-wasm-size.mjs    # enforces size budget (see below)
      - run: npm pack --dry-run npm/kernel/
      - uses: actions/upload-artifact@v4

  build-native:
    strategy:
      matrix:
        include:
          - triple: darwin-arm64
            runs-on: macos-14
          - triple: darwin-x64
            runs-on: macos-13
          - triple: linux-x64-gnu
            runs-on: ubuntu-latest
          - triple: linux-x64-musl
            runs-on: ubuntu-latest
            extra: alpine docker
          - triple: linux-arm64-gnu
            runs-on: ubuntu-latest
            extra: cross
          - triple: win32-x64-msvc
            runs-on: windows-latest
    steps:
      - run: napi build --platform --release --target ${{ matrix.triple }} -p kernel-napi
      - run: cp crates/kernel-napi/kernel.${{ matrix.triple }}.node npm/kernel-${{ matrix.triple }}/
      - run: npm pack --dry-run npm/kernel-${{ matrix.triple }}/
      - uses: actions/upload-artifact@v4

  smoke:
    needs: [build-wasm, build-native]
    strategy:
      matrix:
        target: [wasm-only, native-darwin-arm64, native-linux-x64-gnu, native-win32-x64-msvc]
    steps:
      - uses: actions/download-artifact@v4
      - run: ./scripts/smoke-clean-install.mjs --target ${{ matrix.target }}

  publish:
    needs: [smoke]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - run: ./scripts/publish-all-or-none.mjs   # transactional: publish all or roll back
```

The `publish-all-or-none.mjs` step is the load-bearing piece. It either publishes every package (umbrella + every native peer) at the same exact version, or it publishes none. If npm rejects one of the native peers mid-publish, the script attempts to un-publish (within npm's 72-hour window) and surfaces the failure. ADR-007 §A11 release-gate adopts this script as the canonical publish path for the kernel.

### Size budget

The wasm bundle has a published size budget. Today's reference point (`@ruvector/emergent-time@0.1.0`): 55 KB wasm-opt'd, 40.5 KB tarball with README + `.d.ts` files. The kernel is larger (more subsystems) but the budget keeps it honest.

| Metric | Soft budget | Hard budget |
|---|---|---|
| `kernel_bg.wasm` after `wasm-opt -Oz` | 250 KB | 500 KB |
| Full `pkg/` tarball | 350 KB | 700 KB |
| Per native `.node` binary | 4 MB | 8 MB |

A PR that pushes any metric past its soft budget requires a `[size-growth]` label and CODEOWNERS sign-off. Past the hard budget, the publish is blocked. The script `scripts/check-wasm-size.mjs` runs in CI and surfaces the diff against the previous release.

ADR-007 §A14 covers bundle-size enforcement for the kernel umbrella. This ADR specifies the wasm-side and native-side numbers.

### Smoke contract (clean install in a tmpdir)

The smoke contract for both targets runs from a freshly installed copy of the published tarball, not against the in-tree build. The contract:

1. `mktemp -d`, `cd` into it.
2. `npm init -y`.
3. `npm install @metaharness/kernel@<version>` (resolved from the published artefact in the CI step above).
4. The native peer for the current platform is auto-installed via `optionalDependencies` (or not, for the wasm-only smoke variant).
5. A short Node script (`smoke.mjs`) requires the kernel, calls one method from each of the eight subsystems, and asserts the type signatures match the published `.d.ts`.
6. Smoke variants:
   - `wasm-only`: pre-install hook removes the matching native peer; the loader must fall back to wasm and pass.
   - `native-<triple>`: the native peer is present; the loader must mount native, version check passes, methods work.

`tsc --strict` validation against the published `.d.ts` is part of the smoke. This catches any drift between the Rust source and the generated TypeScript types.

### Wasm/native parity test

The same fixture suite runs once against the wasm bundle and once against each native build. Every output must match bit-for-bit. The fixture covers: HNSW search results on a fixed input set, codemod outputs on fixed source, witness signature bytes for a fixed manifest, MCP tool registration ordering, hooks-runtime firing sequence on a fixed event stream.

This is the gate that catches accidental drift between targets — a Rust feature that compiles for native but not for wasm, or a behaviour difference between `getrandom` on different platforms, or a NAPI marshalling rule that changes a return type. Bit-for-bit parity is strict. Tests that legitimately need non-bit-stable outputs (timing, RNG) are tagged as such and excluded.

### Version-pin enforcement

The lockstep contract is enforced at three checkpoints:

1. **Publish time (in `publish-all-or-none.mjs`).** Every tarball's `package.json` `version` is read and asserted equal before any `npm publish` runs. Any skew aborts the publish.
2. **Install time (in `loader.js`).** When the umbrella loads a native peer, the peer's `__VERSION` constant is compared to the umbrella's `package.json` `version`. Any skew throws.
3. **Drift-check time (per ADR-008).** The harness's `drift check` reads the umbrella's `package.json` and verifies every installed native peer is at the same version.

Three checkpoints means three chances to catch the contract breaking. The runtime check (point 2) is the only one that runs in user-land; the others are CI / build-time. We rely on the runtime check most heavily because it is the only one that survives a partial install or a tampered package.

### `@ruvector/emergent-time` as the precedent

`@ruvector/emergent-time@0.1.0` (https://www.npmjs.com/package/@ruvector/emergent-time) is the working reference for this pipeline. It is already shipping on npm as of this ADR's date (2026-06-13). It uses:

- The Rust → `wasm-pack` → `wasm-opt` → `wasm-tools validate` → npm publish path.
- 62.5 KB → 55 KB wasm via `wasm-opt -Oz`.
- 40.5 KB tarball with README + both `.d.ts` files (the SDK ships `AgenticClock`, `WindowedDeltaClock`, `PageHinkleyDetector`, `LearnedWeights` types).
- `tsc --strict` validated SDK on top.
- Loads via `initSync()` in browser / bundler / Node.
- The cdylib is excluded from the workspace so it does not break the CI shards.

We adopt the same patterns for `@metaharness/kernel`. The native (NAPI-RS) half of the pipeline is new for ruflo at the kernel layer; it is established at the `@ruvector/router` layer already (per-platform `@ruvector/router-<triple>` packages declared as `optionalDependencies` with a wasm fallback). The NAPI-RS path is therefore not novel either; we are composing two known patterns.

ADR-006 documents how the kernel **consumes** `@ruvector/emergent-time@0.1.0` (memory-decay weighting). ADR-002a documents how the kernel itself uses the same publishing infrastructure.

## Consequences

### What gets easier

- **One source-of-truth.** The kernel is one Rust crate. Bindings are generated; they do not drift.
- **Reach is uniform.** Every host that can load wasm loads the kernel; the native peer is an optimisation.
- **Witness determinism is achievable.** Bit-stable wasm execution gives ADR-011's determinism gate real teeth.
- **The publishing machinery is proven.** `@ruvector/emergent-time` ships through it today.

### What gets harder

- **A multi-target build is more CI work.** Six native triples plus wasm means seven concurrent build jobs and a transactional publish step. The single-publish-or-none requirement adds engineering load on the publish script.
- **The Rust → JS surface is one more thing to maintain.** Every kernel API exists as a Rust function with `#[wasm_bindgen]` / `#[napi]` annotations; the generated `.d.ts` is what consumers see. Type changes have to be careful.
- **The size budget is real.** Adding a subsystem that pulls in `serde-json` or `tokio` blows the budget fast. The budget exists to keep that decision visible.
- **NAPI-RS toolchains differ per platform.** Linux musl needs Alpine in a container; macOS arm64 needs an M-series runner; Windows MSVC needs MSVC build tools. CI cost goes up.

### What does not change

- The `@metaharness/kernel` umbrella package's public API surface is the contract (ADR-002 §Public API surface). Whether it is served from wasm or native is an implementation detail invisible to consumers.
- The subpath-export contract is unchanged. ADR-002's eight subpaths (`./mcp`, `./hooks`, `./memory`, `./routing`, `./marketplace`, `./witness`, `./init`, `./hosts`) work the same way regardless of target.
- The harness's `package.json` `peerDependencies.@metaharness/kernel` is unchanged. The harness consumer does not know or care about wasm vs native.

## Alternatives Considered

### Alternative 1: Wasm-only (no native peers)

Ship `@metaharness/kernel` as a wasm bundle, no native binding. Rejected because the cold-start cost of wasm (~30-200ms depending on bundle size and host) is felt every kernel boot. Native bindings, where available, are zero-cost startup. The native path is an optimisation we get cheaply because the Rust crate already exists.

### Alternative 2: Native-only (no wasm fallback)

Ship five-to-six per-platform native peers, no wasm. Rejected because Cloudflare Workers / Deno / Bun / browser cannot load native `.node` files. The whole "cross-platform independence" promise of ADR-002 §Why WASM-centric depends on wasm being the fallback. Without it, a harness running in Cloudflare Workers cannot use the kernel.

### Alternative 3: Two completely separate packages

`@metaharness/kernel-wasm` and `@metaharness/kernel-native`, both published independently, harness picks one. Rejected because the choice forces the harness author to make a decision they do not have enough information to make at install time. The umbrella + runtime triage moves the decision to runtime, where the host's actual capabilities are known.

### Alternative 4: Build the wasm bundle from JavaScript (no Rust)

Skip Rust entirely; write the kernel in JavaScript and use `wasmoon` / `assemblyscript` / similar to get a wasm bundle. Rejected because (a) `wasmoon` is Lua-on-wasm, not JS; (b) AssemblyScript is a TypeScript dialect, not real TypeScript, and the kernel cannot ship a sublanguage as its source; (c) we lose every benefit of Rust (borrow checker, the existing emergent-time crate, the existing ruvector wasm bindings). The Rust path is the right path.

### Alternative 5: Use neon-binding instead of NAPI-RS

`neon` (https://neon-bindings.com/) is the older Node-Rust binding library. Rejected because NAPI-RS is the current best-of-breed (faster, better cross-compilation story, used by SWC and rspack at scale), and `@ruvector/router` already uses NAPI-RS, so we have in-house ops experience with it.

### Alternative 6: Skip the lockstep contract; let versions drift

Allow `@metaharness/kernel` and the native peers to ship at different versions. Rejected because partial publishes are the most common cause of "package installed but doesn't work" bugs at this scale (per the `node-canvas` post-mortems and the early `better-sqlite3` issues). The lockstep contract costs CI complexity; the alternative costs trust.

## Test Contract

This ADR is satisfied when the following exist:

### Build correctness

1. **The wasm bundle builds clean** on a fresh `wasm-pack` invocation, passes `wasm-tools validate`, and stays under the soft size budget.
2. **Each native binding builds** for the six target triples in CI without manual intervention.
3. **The generated `.d.ts` matches** between the wasm and native tracks. A divergence is a build failure.
4. **`tsc --strict` validation** of the generated `.d.ts` succeeds against a stub consumer for each subsystem.

### Lockstep contract

5. **`publish-all-or-none.mjs`** refuses to publish when any tarball's version mismatches. Fixture: synthesise a `package.json` with the wrong version in one peer; the script aborts before any `npm publish`.
6. **`loader.js` version-skew guard** throws when the native peer's `__VERSION` differs from the umbrella's `package.json` `version`. Fixture: synthetic mismatch in a tmpdir install.

### Smoke contract

7. **Clean-install smoke (wasm-only)** — `npm install @metaharness/kernel` in a tmpdir, force the native peer to be absent, the loader falls back to wasm, the eight subsystems' first methods work.
8. **Clean-install smoke (native)** — same, with the native peer present; loader mounts native; methods work; version check passes.
9. **Each native triple's smoke** runs on its matching CI runner.

### Parity

10. **Wasm/native parity fixture** — the same fixture suite (HNSW search, codemod output, witness signature, MCP registration order, hooks firing sequence) runs against both targets; outputs match bit-for-bit.

### Size budget

11. **`scripts/check-wasm-size.mjs`** asserts the wasm bundle is under the soft budget; surfaces the diff against the previous release.
12. **Native binary size check** asserts each `.node` is under its per-triple soft budget.

### Pipeline self-test

13. **A dry-run of the full publish-kernel.yml workflow** runs nightly against `main`. Any regression in the pipeline (a new tool's CLI broke, a new transitive blew the budget) is caught before a real release.

## References

### Working precedents

- `@ruvector/emergent-time@0.1.0` — https://www.npmjs.com/package/@ruvector/emergent-time — the wasm pipeline this ADR adopts.
- `@ruvector/router` and its per-platform native peers (e.g. `@ruvector/router-linux-x64-gnu`) — declared as `optionalDependencies` in the root `package.json` — the NAPI-RS pipeline this ADR adopts.
- PR #566 in `ruvnet/ruvector` (the wasm package source for emergent-time).

### Tooling

- `wasm-pack` — https://rustwasm.github.io/docs/wasm-pack/
- `wasm-bindgen` — https://rustwasm.github.io/docs/wasm-bindgen/
- `wasm-opt` (binaryen) — https://github.com/WebAssembly/binaryen
- `wasm-tools` — https://github.com/bytecodealliance/wasm-tools
- NAPI-RS — https://napi.rs/
- `cross` (cross-compilation) — https://github.com/cross-rs/cross
- npm provenance attestation — https://docs.npmjs.com/generating-provenance-statements

### Background

- "How to write fast Rust → wasm code" — the Rust wasm book: https://rustwasm.github.io/docs/book/
- SWC and rspack — both ship NAPI-RS-based packages at scale; cite as production examples.
- in-toto attestation v1 — https://github.com/in-toto/attestation — the supply-chain attestation format that wraps the witness manifest (ADR-011) and applies equally to the kernel's published tarballs.

### Ruflo ADRs cited

- ADR-002 (Kernel boundary) — the gating decision.
- ADR-006 (Memory + learning) — the consumer of `@ruvector/emergent-time` inside the kernel.
- ADR-007 (CI guards) — the pipeline gates this ADR's matrix implements.
- ADR-011 (Witness) — the determinism rationale this ADR's wasm/native parity test serves.
