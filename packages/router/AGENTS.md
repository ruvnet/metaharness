# @metaharness/router package guidance

This package is `packages/router` in `ruvnet/metaharness`. Follow
[`CONTRIBUTING.md`](../../CONTRIBUTING.md),
[`SECURITY.md`](../../SECURITY.md), and the checked-in
[continuous package improvement policy](../../docs/ecosystem/package-improvement-policy.md).
For a published tarball, those repository-relative files live in the matching
source checkout, not necessarily inside the installed package. Verify the
package version and source commit before applying guidance from a newer branch.

## Contract and integration boundaries

- Preserve public exports, ESM/types entry points, Node support, k-NN routing,
  kernel-ridge training, JSON model round trips and calibration semantics.
- Preserve candidate pricing, quality-bar selection and fallback behavior.
  Estimated quality or cost is not a measured improvement on an end-user task.
- `@ruvector/tiny-dancer` is an optional peer. Keep pure-JavaScript routing
  usable without native packages. Do not make the native engine mandatory to
  create a dependency edge or increase download counts.
- Native training and native routing have distinct dimensional constraints.
  Preserve explicit errors and availability/fallback behavior; never count a
  test that returns early when the native engine is absent as native validation.
- Training data, held-out evaluation and promotion authority stay separate.
  Do not tune on held-out cases, silently change thresholds, or treat training
  accuracy as proof of model quality, lower cost or downstream task success.
- Persisted JSON and safetensors artifacts need source/version/hash provenance.
  This package's routing decisions do not grant tool, network or release authority.

## Bounded validation and handoff

1. Read package.json, source, tests and ADR-043 before changing routing behavior.
   Use an isolated worktree and the shared policy's expiring ownership lease.
2. From this package directory run `npm run build`, `npm run lint` and
   `npm test`. Record exact dependencies and platform. Exercise both an absent
   optional peer and an installed compatible native peer when relevant.
3. Inspect `npm pack --json` contents and sizes. In a fresh consumer verify
   imports, routing, train/serialize/reload behavior and unavailable-native errors.
   Native claims additionally require real train/persist/load/route execution.
4. Preserve fixed and last accepted baselines, applicable regressions and
   source/artifact hashes. Record failed checks and explicit rollback limits.
   A documentation-only pack change is not a runtime interoperability gain.
5. Retain independent review and all repository Rust, WASM, native, workspace,
   security and signed/provenance release gates. Package-local checks do not
   establish full release readiness. Do not publish from this maintenance loop.
