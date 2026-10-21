# @metaharness/turn-credit agent guidance

Scope: `packages/turn-credit`, package `@metaharness/turn-credit` (source version
0.1.0). Preserve applicable ancestor instructions, `CONTRIBUTING.md`,
`SECURITY.md`, and [the shared improvement policy](../../docs/ecosystem/package-improvement-policy.md).
The shared policy is checked into the source repository, not bundled in this
package; installed consumers can consult the matching source commit. This file
is included in the npm pack. Source documentation and pack inspection do not
establish a signed release.

## Contract and boundaries

- Dependency-free ESM TypeScript for Node >=20; preserve the root and `./cli`
  exports, declarations, deterministic digests and existing public shapes.
- Inputs are recorded per-turn evidence or score pairs, a verifier outcome and
  a prior. Outputs are belief revisions, bounded credit multipliers, advisory
  routing labels, retrieval feedback and receipt payloads. The caller supplies
  evidence and performs any persistence, signing or downstream execution.
- Preserve positive multipliers and terminal-outcome sign. `GOVERNED_DEFAULTS`
  bounds modulation at +/-10% when used without caller overrides. Keep proxy
  evidence explicitly labelled; do not call it token-logprob evidence.
- `attributeMutation` is advisory, not promotion authority. This package does
  not train a model, execute agents, authorize retrieval, or sign receipts.
  Structural adapter compatibility is not proof of runtime interoperability.
- Do not add dependencies just for graph connectivity. Keep private traces,
  credentials and signing keys out of fixtures, logs and published evidence.

## Validation and improvement

From this package directory, run `npm run build`, `npm run lint` and
`npm test -- --root ../.. packages/turn-credit/__tests__/turn-credit.test.ts --maxWorkers=1 --minWorkers=1`, using source-compatible pinned
development tooling. Repository-wide Rust/WASM/native, security and release
gates in `CONTRIBUTING.md` remain mandatory; scoped passes do not waive them.

Use identical baseline/candidate inputs and inspect complete built `npm pack`
contents and sizes. Install each tarball in a fresh consumer with the same
script/cache policy. Exercise success, failure and neutral outcomes, governed
weight bounds, proxy labels, retrieval feedback, deterministic receipts, and
CLI process -> process exit -> report. This tests a local package consumer,
not model quality or physical crash durability.

Preserve fixed and last accepted evidence with exact source/artifact hashes,
versions, commands and failures. Require an executable reproducer for fixes;
quantitative gains need >=10% measured improvement and zero applicable
regressions. Repeated unchanged passes are retained evidence, not new gains.
Use isolated ownership, bounded work and a reviewable PR. Reverse the exact
source patch for rollback; source rollback does not reverse consumer effects.
Publication, signing and promotion need their existing independent authority.
