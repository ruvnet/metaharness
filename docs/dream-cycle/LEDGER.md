# MetaHarness Dream Cycle — Ledger

Durable memory across nightly Dream Cycle runs. One row per night. See
`docs/dream-cycle/${DATE}-gist.md` (or the published gist) and the linked
issue/PR for full detail.

| Date | Deep | Finding | Issue | PR | Evaluated? | Verdict | Effect | Witness | Prior-night fates |
|---|---|---|---|---|---|---|---|---|---|
| 2026-08-13 | security-adversarial | Added `indirect_prompt_injection` (OWASP LLM01 indirect, CVE-2025-32711-backed) as redblue's 6th attack family; independent critic caught+fixed a keyword-collision confound before ship | #180 | #181 | yes | ACCEPT-WITH-CAVEATS | live spend $0.00042, 0/6 offline-suite regression, vacuous true-negative on the new family (target has no tool-channel model) | `398c71a6...` | n/a (first ledger entry) |
| 2026-08-14 | host-adapters | Fixed hermes YAML mapping-key injection (`AgentSpec.name`/`HarnessSpec.name` unescaped into `agent.personalities.<name>:`) in all 3 byte-for-byte-parity codegen paths (adapter, CLI scaffold, web-UI); critic caught+fixed a reserved-bare-scalar hazard (`true`/`null`/`123`) pre-ship and flagged 2 still-open sibling gaps (comment-line + MCP-value injection), disclosed not hidden | #187 | #188 | yes | ACCEPT-WITH-CAVEATS | 19+15+18/18 tests green (13→19, 13→15, 16→18), 0 regressions across 454+69 unaffected full-suite tests, deterministic before/after repro (no live spend) | `1e859efa...` | #180/#181 MERGED |
| 2026-08-15 | generator-genome | `scorePublishReadiness` locked python/go repos out of `'ready'` (language-credit allow-list covered only typescript/rust); generalized to any detected language + python/go `buildCommands` inference; critic-caught reward-hack probe closed with a 19th test | #199 | #200 | yes | ACCEPT-WITH-CAVEATS | 477 passed / 2 pre-existing skips, 0 regressions; rust readiness 0.15→0.30 side-effect verified to cause no verdict-threshold flip | `b8c11365...` | #181/#188 MERGED |
| 2026-08-16 | flywheel-promotion | `verifyReplayBundle` verified receipts only on the promoted `chain`, never `all_commits`; critic caught a deeper receipt-splicing/verdict-flip gap (no id/verdict-vs-payload cross-check) the first fix missed, closed pre-ship; ADR-252 filed | #204 | #205 | yes | ACCEPT-WITH-CAVEATS | flywheel suite 47→52/52, 0 regressions; 4 real committed replay bundles re-verified PASS under the hardened logic | `c28913c0...` | #200 OPEN (backfilled — see note below) |
| 2026-08-17 | darwin-evolution | ADR-249's `signals.cost` scorer seam shipped 2026-08-10 but was never wired into `evolve()`'s only production call site — structurally unreachable; added `EvolutionConfig.costBudgetBytes`, threaded through using the already-computed `variantBytes` parsimony signal | #206 | #207 | yes | ACCEPT-WITH-CAVEATS | darwin-mode suite 632/632 (14 pre-existing skips), 0 regressions; crafted near-tie fixture shows the decay alone can flip a promotion decision | `57ed9167...` | #200/#205 OPEN (backfilled) |
| 2026-08-18 | security-adversarial | `mcp-scan`'s risky-bash-allow regex missed arbitrary-code interpreters (`python`/`node`/`ruby`/…) and unscoped bare `Bash`/`Bash(*)`; real repro against `metaharness --template vertical:ai` showed a live unflagged `Bash(python *)` grant | #209 | #210 | yes | ACCEPT-WITH-CAVEATS | create-agent-harness 457/457 (2 pre-existing skips), 0 regressions; real-CLI + deterministic dual repro | `007959c6...` | #200/#205/#207 OPEN (backfilled) |
| 2026-08-19 | host-adapters | Closed the sibling `github-actions` shell/YAML injection: `cfg.name`/`spec.name` unescaped in a bash `run:` line (RCE-shaped) and in `#`-comment/step-name lines (arbitrary top-level YAML key injection), across all 3 byte-parity codegen paths; 3 independent critic rounds each found real gaps in the prior round's fix (missed sibling comment site, YAML-layer truncation the bash-escaping alone didn't close, an inaccurate reachability comment) before round 3 returned ACCEPT | #211 | #212 | yes | ACCEPT | 460/462 + 24/24 + 71/71 tests green (0 regressions, +7 new), real YAML-parse + real-bash-exec repro pre/post-fix, 258/-9 line diff | `c48970bc...` | #187/#188 MERGED |
| 2026-08-24 | host-adapters | host-rvm's generated `install-rvm.sh` had a live RCE: `spec.name` unescaped in 2 double-quoted bash sites (`$(...)`/backtick command substitution) AND 2 raw `#`-comment header lines (bare newline breaks out, no quoting needed); round-1 critic caught the comment-line sibling the author missed, round-2 critic independently confirmed closed | #223 | #224 | yes | ACCEPT-WITH-CAVEATS | host-rvm 41/41 (0 regressions), dependent bench 5/5, tsc+build clean; real bash-exec repro both rounds (marker file created pre-fix, not post-fix) | `fc5f47bc...` | #200/#205/#207/#210/#212 still OPEN — 5 consecutive dream-cycle PRs unreviewed/unmerged; see note below |
| 2026-08-28 | security-adversarial | `harness audit`/`harness sbom` silently excluded devDependencies by default with no disclosure (repo's own dev tree: 1 critical + 4 high advisories, invisible at default scope); disclosed suppressed/excluded counts without changing default gating; self-critique caught+fixed an adjacent `total`-field double-counting bug the new disclosure line itself exposed. `threat-model`'s MCP-in-use false-negative (misses `.claude/settings.json` `mcpServers`) found but deliberately not fixed tonight (0/9-merged bias toward one small candidate) — flagged for next night | #242 | #243 | yes | ACCEPT | 468/468 tests passed (2 skipped, baseline 467/467), 0 regressions, deterministic before/after repro on this repo's real dependency tree, no live model spend | `216c5f51...` | 08-15→08-19,08-24→08-27: 9 nights, 0 merged, all OPEN/draft (2 already-disclosed RCE fixes #212/#224 unreviewed 11-15 days); 08-27 (#240) already backfilled LEDGER for 08-15..08-27 on its own unmerged branch — merge #240 before/alongside this row to reconcile |
| 2026-08-29 | host-adapters | Fixed `host-openclaw` YAML/shell injection via unescaped `spec.name` in `skillMarkdown()`/`installScript()` — 4th confirmed sibling of #188 (hermes)/#212 (github-actions)/#224 (host-rvm); independent critic ACCEPT-WITH-CAVEATS, confirmed #224's fix is NOT on `main` (RCE still live). Flagged 0/10-merged backlog as tonight's most urgent finding. | #245 | #246 | yes | ACCEPT | 0 regressions, 19→25/25 host-openclaw tests, 148/148 bench tests, red/green-proven | `3dcc14d1...` | #224/#212 confirmed unmerged & one (RCE) unpatched on main; #240/#243 also unmerged |

**Note on 2026-08-15 → 08-19 backfill (added 2026-08-24):** rows above for
these 5 dates were absent from this file on `main` until tonight, even
though all 5 Dream Cycle nights ran and produced real branches/issues/PRs
(#199-212) — confirmed via `git ls-remote` and `gh`-equivalent PR listing,
not inferred from the gap. Cause: STEP 25 commits its ledger row to the
night's own `dream/*` branch, and none of these 5 PRs have been merged to
`main` yet (0 of 5, still open/draft as of 2026-08-24), so their ledger
rows never reached `main` for a later night to read. This is a real gap in
the Dream Cycle design, not a cosmetic one — future nights reading this
file were blind to 5 nights of findings until this backfill. Flagged as a
process finding for ADR-251, not fixed tonight (out of tonight's
`host-adapters` DEEP scope): a durable ledger needs a write path that
doesn't depend on PR merge.

**Note on 2026-08-20 → 08-23 (no Dream Cycle entries):** no `dream/*`
branch, PR, or `dream-cycle`-labeled issue exists for these 4 dates
(verified via `git ls-remote --heads origin "dream/*"` and a full PR/issue
listing) — the nightly routine did not run on these nights; the repo
activity in that window (PRs #213-221) is a separate, larger workstream
(`@metaharness/avo` governed autonomous variation runtime, ADR-251-adjacent
naming coincidence with the Dream Cycle's own ADR-251, unmerged as of
2026-08-24). Reported as a real gap per direct evidence, not inferred from
ledger sparseness alone.
