# ADR-272: Consolidating three unmerged flywheel-replay trust-boundary fixes, and closing a 4th (chain-shape binding)

- **Status**: Accepted — consolidated, extended, regression-tested, verified against every real committed
  `ReplayBundle` in the repo.
- **Date**: 2026-09-01
- **Deciders**: MetaHarness Dream Cycle (autonomous nightly research), slot 1 (flywheel-promotion)
- **Tags**: flywheel, replay, verifier, receipts, provenance, chain-integrity, metaharness, process
- **Extends**: ADR-235 (independent re-executing verifiers + honest-null replay), ADR-254 (anti-Goodhart
  anchor re-execution during replay)
- **Related**: PR #205 (2026-08-16, unmerged), PR #231 (2026-08-26, unmerged), PR #255 (2026-08-31,
  unmerged) — the three fixes this ADR consolidates
- **Prompted by**: an operational finding, not a new vulnerability search — three consecutive
  flywheel-promotion Dream Cycle nights each disclosed and fixed a real trust-boundary gap in
  `verifyReplayBundle`, and all three PRs remain unmerged 2–17 nights later, conflicting with each other
  at the git level despite being semantically independent.

---

## Context

`packages/flywheel/src/replay.ts`'s `verifyReplayBundle()` lets an external reviewer establish trust in a
promotion lineage with zero trust in the producer (ADR-233/234/235). Between 2026-08-16 and 2026-08-31,
three separate Dream Cycle nights each found and fixed a distinct, real gap in this same function:

1. **PR #205** (2026-08-16): `verifyReplayBundle` verified receipts only on the promoted `chain`, never on
   `bundle.all_commits` (the full promoted+rejected diagnostic ledger) — a receipt-splicing or
   verdict-flip forgery on a REJECTED entry would not fail replay. Also: a PROMOTED commit missing sealed
   scores was silently *skipped* by `gateReExecutes` rather than failed.
2. **PR #231** (2026-08-26): `gateReExecutes` never supplied `evidence.anchor`, so the anti-Goodhart anchor
   clause (ADR-254) was structurally unreachable during replay — a promotion that regressed the frozen
   anchor replayed clean. Also hardened `isCompleteScore` (a `Score` object with a missing/mistyped field
   is as unusable as a missing one — JS `<`/`>` comparisons on `undefined` fail open).
3. **PR #255** (2026-08-31): nothing bound a receipt's *signed* score/id/verdict fields to the commit's
   *live* fields — a bundle editor with no signing key could splice favorable scores onto a commit
   post-signing, or clone one genuine receipt onto a fabricated commit id to manufacture a fake
   multi-generation lineage from a single real promotion.

Each PR explicitly disclosed the next gap as a "natural follow-up," and each was independently reviewed by
a critic sub-agent before shipping. All three are real, well-evidenced fixes. **All three remain open,
unmerged draft PRs** — along with 10 other Dream Cycle PRs from the same period (2026-08-15 through
2026-08-31), none merged. This matches a documented industry pattern, not a MetaHarness-specific failure:
Duma et al., "These Aren't the Reviews You're Looking For: How Humans Review AI-Generated Pull Requests"
(EASE 2026, arXiv:2605.02273) find most AI-generated PRs receive no review, and when they are reviewed,
review is often agent-steering rather than standalone human evaluation. LinearB's 2026 benchmark report
(8.1M PRs) independently measures 5.3x longer pickup time for agentic-AI PRs.

A direct architectural investigation (this session, worktree experiment against `origin/main`
`b611993d7088dff877f5713e41031a714e77bfc0`) confirmed **why** these three PRs conflict at the git level
despite being logically compatible: all three independently rewrite the same ~15-line region of
`gateReExecutes`'s loop body and the `checks`/header shape, because each was authored against a base that
predated the others. Cherry-picking them in dependency order hits a real textual conflict at every step.
Hand-resolving those conflicts and combining all three (union of checks, no side dropped) builds clean and
passes the full test suite (71/71 before this ADR's own addition, see below).

**A 4th gap, not disclosed by any of the three PRs, was found by this session's independent adversarial
critic during review of the consolidated diff**: even with all three fixes combined, `sealedFieldsAuthentic`
(PR #255's own mechanism) binds `id`/`target`/`verdict`/`primaryDelta`/the score fields/`failureReasons` —
but not `parents` or `generation`. A working exploit was constructed and verified: an attacker with no
signing key can take **two independently, genuinely signed** PROMOTED commits (each still correctly bound
to its own id and scores — so points (6) and (7) as they stood do not catch this) and splice them into a
fabricated multi-generation chain by rewriting only the unsigned `parents`/`generation` fields. Every
per-commit check passes; `contiguousParents` and `reachesRoot` then reconstruct a chain shape the producer
never actually signed — directly defeating file-header guarantee (2), "the promoted lineage reconstructs
current → gen-0 immutable root, contiguously." This is a real, silent gap, not a merely-cosmetic one, and
is closed in the same diff rather than left disclosed-not-fixed, since it is a one-line extension of an
already-shipped mechanism (bind two more keys) rather than new design.

## Decision

1. **Consolidate, don't re-derive.** `packages/flywheel/src/replay.ts`, `run.ts`, and `cli.ts` now carry
   the union of all three PRs' fixes, hand-merged (not textually rebased) against current main:
   `receiptMatchesCommit` + `allCommitsReceipts` (#205), fail-closed `isCompleteScore` + anchor
   re-derivation from the root's sealed `anchorScore` (#231), and `sealedFieldsAuthentic`/`BOUND_KEYS`
   plus signing `baselineScore`/`candidateScore`/`anchorScore`/`failureReasons` into the receipt payload
   (#255). No fix's logic was dropped or weakened in the merge.
2. **Close the 4th gap in the same diff.** `BOUND_KEYS` now also binds `parents` and `generation`; `run.ts`
   signs both into the candidate receipt payload alongside the existing sealed fields. Additive, same
   opt-in-by-payload-key design as the rest of `sealedFieldsAuthentic` — a receipt from before this ADR
   (carrying neither key) is left unchecked for chain-shape binding, matching every other field's
   backward-compatibility contract.
3. **This PR supersedes #205, #231, and #255 in effect.** It does not close them by fiat (this session
   never closes another PR); the recommendation to the human reviewer is to close those three once this
   consolidated PR merges, since their logic is fully subsumed here plus one additional closed gap.
4. **Process lesson, not just a code lesson.** The recurring conflict pattern (three independent nights
   fixing the same function) is evidence that "small reviewable diff" and "avoid stacking on an unreviewed
   base" are in tension once a review backlog exists. Tonight's slot was spent on consolidation *instead
   of* a 4th independent stacked fix, per this repo's own STEP 1.1 learning-signal guidance ("multiple
   ACCEPTs never merged → treat reviewability... as part of tonight's optimization objective").

## Consequences

- **Trust model strengthened on all four axes simultaneously**: full diagnostic ledger receipt integrity,
  anti-Goodhart anchor re-execution, sealed-score/id tamper-evidence, and now chain-shape (parents/
  generation) tamper-evidence — the last of which no prior PR closed.
- **Reviewer burden reduced, not added to.** One coherent, tested PR replaces the need to review three
  overlapping, git-conflicting ones — net backlog effect is negative (removes review burden) rather than
  the usual Dream Cycle candidate (adds one more PR to an already-deep queue).
- **No behavioral change for any honestly-produced bundle.** Verified directly against all 7 real
  committed `ReplayBundle`/proof-bundle files in the repo (`packages/radio/.radio-flywheel/`,
  `kimi-k3-harness/.harness/flywheel/`, `packages/darwin-mode/bench/swebench/`,
  `packages/evals-math/bench/proof-bundle-gsm8k*.json` ×3, `experiments/signal-flywheel/bundle.json`) —
  all still verify `pass: true`, all 8 checks green (including the 2 new ones), unchanged.
- **Known, pre-existing, explicitly out-of-scope residual gap** (flagged by this session's adversarial
  critic, not introduced or regressed by this diff): `verifyReceipt` checks a receipt's signature against
  its own *embedded* public key; nothing in `ReplayBundle`/the CLI pins an expected/trusted key across the
  bundle, so an attacker could in principle self-sign an entirely fabricated bundle with a fresh keypair.
  This predates every one of the four fixes above and is a distinct, larger follow-up (key-trust/allowlist
  design, analogous to meta-llm's `FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON` per ADR-271) — not attempted here.

## Alternatives Considered

- **Ship a 4th independent stacked PR** (closing only the parents/generation gap on top of the existing,
  still-unmerged #205/#231/#255). Rejected: this would be PR #16 in a 13-deep unreviewed queue, on the
  same conflicting file, making the eventual human-review task strictly harder, not easier — the opposite
  of what tonight's STEP 1.1 learning signal calls for.
- **Wait for a human to merge #205/#231/#255 first, then submit the 4th gap separately.** Rejected: no
  timeline guarantee, and the three PRs' own conflict-at-the-git-level problem would still need solving by
  someone eventually; solving it now, with the additional gap closed in the same pass, is strictly more
  useful evidence for the human reviewer than three more nights of "wait and see."

## Test Contract

- `npx vitest run packages/flywheel` → 72/72 passing (was 71/71 for the 3-way consolidation alone; +1 for
  the parents/generation splice regression test).
- Before/after non-vacuous proof for every new check: with the corresponding fix stashed/reverted, the
  matching new test(s) fail with the exact predicted assertion (verified directly, not assumed, for both
  the 3-way consolidation as a whole — 18/41 new-test failures against unpatched `replay.ts` — and the 4th
  gap specifically — the splice test fails `expected true to be false` with `BOUND_KEYS`'
  `parents`/`generation` entries removed).
- Real-bundle regression: all 7 committed `ReplayBundle`/proof-bundle files in the repo re-verified
  `pass: true`, unchanged, against the patched `dist` build.
- Full monorepo `npm run build` (all 4 phases) and the broader consuming-package suite
  (`packages/flywheel packages/evals-math packages/darwin-mode`) — 715/715 non-skipped tests green.

## References

- PR #205, #231, #255 (this repo, `dream/2026-08-16-flywheel-promotion`, `dream/2026-08-26-flywheel-promotion`,
  `dream/2026-08-31-flywheel-promotion` branches) — the three consolidated fixes.
- ADR-235, ADR-254 — the re-executing-verifier and anchor-re-execution discipline this ADR extends.
- Duma, Wróblewski, Bobińska, Winiarska, Przymus, "These Aren't the Reviews You're Looking For: How Humans
  Review AI-Generated Pull Requests," EASE 2026, arXiv:2605.02273.
- Zhao, Srikanth, Wu, Jiang, "SpecBench: Measuring Reward Hacking in Long-Horizon Coding Agents,"
  arXiv:2605.21384 — cited in tonight's research as a reason to track promoted-diff size as a covariate on
  anchor-suite fidelity (not implemented tonight; a natural next-flywheel-promotion-night candidate).
