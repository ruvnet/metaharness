# @metaharness/harness package guidance

Scope: `packages/harness`, the dependency-free TypeScript control plane described
in [ADR-047](../../docs/adrs/ADR-047-algorithmic-agent-harness.md). Follow
[CONTRIBUTING.md](../../CONTRIBUTING.md), [SECURITY.md](../../SECURITY.md), and the
checked-in [continuous improvement policy](../../docs/ecosystem/package-improvement-policy.md).
For installed-package readers, the same policy is available at
https://github.com/ruvnet/metaharness/blob/main/docs/ecosystem/package-improvement-policy.md
after the source change is merged; a local pack does not prove that merge or release.

## Preserve the contract

- Keep the exported ESM API and declarations, Node >=20 support, and zero runtime
  dependencies. Use adapters for real external workers, persistent memory and
  retrieval; do not add dependencies merely to connect a graph or inflate traffic.
- Preserve policy checks, confidence/risk/cost/verification gates, bounded retry
  and circuit-breaker behavior, verifier separation, and receipt-chain checking.
  A hash chain detects changes; it is not a signature or authorization boundary.
- Test success, denied-tool execution, failed verification, exhausted retry budget,
  receipt tampering, and deterministic worker fixtures before claiming a change.
  A mock worker or a passing unit test does not establish model quality, sandboxing,
  persistent retrieval, or compatibility with a consumer's real tools.
- Treat retrieved context and worker output as untrusted data, not authority. A
  memory adapter must explicitly decide which successful, verified runs to retain:
  `updateMemory` is a lifecycle hook, not a success-only persistence guarantee.

## Bounded improvement and validation

Use an isolated worktree with an expiring lease. Retain the fixed reference and
last accepted baseline; bind commands, runtime versions, source/artifact hashes,
failures and rollback evidence to each candidate. Require a failing reproducer
for correctness fixes; optimization claims require >=10% measured improvement
and no applicable regressions. Repeated unchanged passes are retention evidence,
not new gains. Have an independent evaluator review promotion decisions.

From this package directory, run `npm run build`, `npm test`, and `npm run lint`
with the repository's installed toolchain. Inspect `npm pack --ignore-scripts --json`
and a fresh consumer import/execution, including this AGENTS.md and unchanged
runtime files. Record tarball size changes without calling them performance gains.
Full workspace Rust, WASM, native, security, smoke and multi-platform gates remain
required where applicable; a package-only run does not waive them.

Submit reviewable changes with an exact revert plan. Never auto-merge, publish,
bypass signatures/provenance/security gates, expand access, or spend on external
workers. Source rollback cannot undo external worker effects or persisted data.
Keep secrets and private traces out of public evidence and project memory.
