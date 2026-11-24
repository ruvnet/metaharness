# Dream Cycle Evidence — 2026-11-24 — host-adapters

## Classification
- **Finding type**: MEASUREMENT (real test execution before/after, not inference).
- **Hypothesis**: HYPOTHESIS → DECISION (ACCEPT-WITH-CAVEATS).

## Hypothesis (frozen before implementation)
Given a `HarnessSpec` with non-empty `mcpServers`, when `@metaharness/host-rvm`'s
`installScript()` runs, then the generated `install-rvm.sh` should contain an
explicit, ADR-246 §2.2-citing disclosure naming every declared MCP server
(mirroring the existing `spec.autonomous` disclosure block), subject to:
- no change to any other generated file when `mcpServers` is absent/empty;
- an attacker-controlled server `name` cannot break out of its `#`-comment
  line into an executable shell statement;
- zero regressions in `host-rvm`, `@metaharness/bench` (its one known
  downstream importer), and the full monorepo test sweep.

## Baseline
`packages/host-rvm/src/index.ts` at commit `47c4c79d156352aec9a0fec1774b62c0b0deb758`
(repo HEAD at session start). `installScript()` disclosed `spec.autonomous`
as a documented ADR-246 §2.2 no-op but had no equivalent block for
`spec.mcpServers` — a spec declaring MCP servers, scaffolded `--host rvm`,
produced zero signal anywhere (`install-rvm.sh`, `rvm-partition.toml`,
`capability-table.json`, `wasm-guest.json`) that those declarations don't
apply to this host.

## Candidate
Additive block in `installScript()`, directly after the existing
`spec.autonomous` disclosure, firing when `spec.mcpServers` is non-empty:
cites ADR-246 §2.2, states the real architectural reason (RVM exposes
capability-token rights + a wasm-guest lifecycle, not an MCP tool-call
transport), and lists every declared server name via the file's existing
`commentSafe()` escaping helper. ~12 lines of production code in one file;
2 new tests in `packages/host-rvm/__tests__/rvm.test.ts`.

## Evaluation receipt
Evaluator: `vitest` (`packages/host-rvm/__tests__/rvm.test.ts`, then
`packages/host-rvm` + `packages/bench`, then full repo-root `vitest run`),
plus `tsc --noEmit`, plus `npm run build`.

| Stage | Result |
|---|---|
| Pre-fix (source stashed, test file kept) | 1 failed / 43 passed (44) — new disclosure test failed exactly as predicted (no ADR-246/mcpServers text in output) |
| Post-fix | 44/44 passed, 0 regressions on the 42 pre-existing tests |
| `host-rvm` + `@metaharness/bench` | 192/192 passed |
| Full repo-root `vitest run` | 366 passed / 1 failed / 4 skipped files; 4256 passed / 61 skipped tests. 1 failure: `packages/avo/__tests__/openrouter-live.test.ts`, live OpenRouter 404 (Qwen3 8B deprecated 2026-10-09) — pre-existing documented flake, unrelated (matches the recurring signature reported 2026-10-26/10-31/11-01/11-06/11-11) |
| `tsc --noEmit` (host-rvm) | clean |
| `npm run build` | clean (JS workspaces; `wasm-pack` unavailable in this sandbox, pre-existing environment limitation, recorded degradation, unrelated to this candidate) |
| Live CLI smoke test | `adapter.generateConfig()` called directly against the built `dist/index.js` with a real `mcpServers` entry; confirmed the disclosure renders correctly in the generated `install-rvm.sh` |

## Critic decision
Self-adversarial review only — this session is itself a spawned fork at the
subagent-nesting depth limit (parent session already at depth 1), so a
separate `Agent`-tool critic could not be spawned. Disclosed, not simulated.
Reviewed: correctness of the RVM-has-no-MCP-surface claim (verified
directly against the file and ADR-044's 2026-06-16 coverage matrix);
0/1/N-server rendering; comment-escaping security (reused existing
`commentSafe()`, additionally probed against Unicode line/paragraph
separators U+2028/U+2029 — these pass through unstripped but are not shell
line terminators, so not exploitable in this `#`-comment context); test
non-vacuousness (confirmed via `git stash`); blast radius (additive-only,
one downstream importer re-tested clean); scope (one conceptual change).

## Darwin lineage
Not attempted — no tunable numeric/routing/genome parameter; outside
Darwin's eligible mutation surfaces per ADR-071.

## Reward-hack check
No benchmark/gold data involved. No test weakened, removed, or loosened —
diff is purely additive (2 new tests, ~12 new production lines). No metric
substitution, no seed manipulation, no selective task removal.

## Security review
This candidate touches `install-rvm.sh` generation, a shell script a human
later executes — directly security-relevant. See Critic decision above for
the comment-injection analysis; conclusion: not exploitable, no change to
the existing `commentSafe()` helper's risk profile.

## Final verdict
**ACCEPT-WITH-CAVEATS** (caveat: self-critique only, disclosed above).

## Witness
- Session commit: `47c4c79d156352aec9a0fec1774b62c0b0deb758`
- Gist report SHA-256 (pre-witness-section content): `90055bc343cf20506840ab31c32b8b6c9ddb19aa70f07e3cf4cd654ec61b6793`
- Witness stamp: `e494b4a8a781b6f9f581fb8d41591c30f9fad1e13e5ee19618f43a2e9989e1b2`
