# @metaharness/weight-eft contributor guidance

Package: `@metaharness/weight-eft`; source: `packages/weight-eft` in
`ruvnet/metaharness` (formerly `ruvnet/agent-harness-generator`).
Read the repository's `CONTRIBUTING.md` and, in a source checkout, the
[shared package policy](../../docs/ecosystem/package-improvement-policy.md).
Those source-only documents are not bundled in this npm package; this file
retains the essential package constraints for artifact consumers.

## Contract and safety

- Public ESM exports are `.` and `./cli`; `weight-eft` is the CLI. Preserve
  Node >=20 support, declaration files, CLI inputs, report fields and exports.
- Input is an archived `DarwinTrajectory[]`. Outputs are portable SFT chat
  JSONL, on-policy cheap-vs-cheap DPO pairs, training plans and cascade cost
  summaries. Check `src/types.ts`, `src/export.ts` and the package README.
- Keep train/eval instance IDs disjoint, preserve tool-call trajectories,
  reject reward-hacked samples and report every holdout or length exclusion.
  Do not weaken guards to improve a benchmark or export more examples.
- Training-plan emission is not model training. Preserve dry-run defaults
  and the explicit training plus GPU/endpoint gates. No paid training,
  remote execution, model download or publication is authorized by this file.
- Keep adapter evaluation independent of training data. A lower-cost plan is
  not evidence of improved held-out task success or lower measured cost.
- Never add dependencies merely to connect the graph or inflate npm counts.

## Acceptance and evidence

From this package directory run `npm run build`, `npm run lint` and
`npm test` with the repository's source-compatible development dependencies.
All six test files are relevant: export, eval, genome, train and the two
reward-hack suites. Also execute the repository health check from its root.
Full Rust/WASM/workspace and signed CI release gates remain authoritative;
focused package checks do not replace them.

Inspect `npm pack --json --ignore-scripts` after building. Confirm built
entry points, declarations, README, LICENSE and AGENTS.md are present.
Compare package size and nonmanifest runtime bytes against the fixed source
baseline. Use an isolated worktree and expiring ownership. Record exact
source hashes, commands, failures, rollback and later retained validation.
Correctness claims need a failing baseline reproducer; optimization claims
need at least 10% measured improvement with zero applicable regressions.
Keep independent review and existing promotion, signing and release authority.
Documentation, passing tests and pack verification never authorize publishing.
