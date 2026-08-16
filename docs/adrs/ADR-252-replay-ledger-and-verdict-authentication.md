# ADR-252: Replay verification covers the full diagnostic ledger + authenticates verdict/id, not just the promoted chain

- **Status**: Accepted — implemented in `packages/flywheel/src/replay.ts`, regression-tested in
  `packages/flywheel/__tests__/units.test.ts` (8 new tests across 2 describe blocks), re-verified
  against every committed `ReplayBundle` in the repo (see Test Contract).
- **Date**: 2026-08-16
- **Deciders**: ruv (via MetaHarness Dream Cycle, automated nightly research + bounded evolution)
- **Tags**: flywheel, replay, receipts, provenance, verdict-authentication, metaharness
- **Extends**: ADR-233/234 (lineage), ADR-235 (re-executing verifiers + honest-null replay — the same
  function this ADR further hardens)
- **Artifacts**: `packages/flywheel/src/replay.ts` (`allCommitsReceipts` check,
  `receiptMatchesCommit()`), `packages/flywheel/src/cli.ts` (surfaces the new check),
  `packages/flywheel/__tests__/units.test.ts`, `docs/dream-cycle/2026-08-16-gist.md` (full evaluation
  receipt), issue #204

---

## Context

`@metaharness/flywheel`'s `verifyReplayBundle()` is the function an external reviewer uses to
establish trust in an autonomous policy-promotion run "with no trust in the producer" (its own file
header's claim). ADR-235 (2026-07-06) hardened it once: fixed a false-FAIL on legitimate 0-promotion
("honest-null") bundles, and added `gateReExecutes` — re-running the frozen `meetsPromotionRule` on
each PROMOTED commit's *sealed* baseline/candidate scores, so a reviewer trusts the gate re-run, not
the logged verdict.

Tonight's Dream Cycle audit (issue #204) found ADR-235's discipline hadn't reached everywhere it
should have:

1. **`all_commits` was unverified.** A `ReplayBundle` carries two collections: `chain` (the winning
   lineage) and `all_commits` (every candidate across every generation, PROMOTED *and* REJECTED — the
   "full diagnostic ledger" `analyzeBundle`'s rejection-reason/cost-per-win/mutation-effectiveness
   reporting reads). `run.ts` signs every commit it mints regardless of verdict, but
   `verifyReplayBundle` only checked `chain`'s receipts. The signatures needed to catch tampering in
   the diagnostic ledger already existed in the data; they simply weren't checked.

2. **A missing-scores PROMOTED commit was silently skipped, not failed.** `gateReExecutes` only
   re-gated a commit when it had both `baselineScore` and `candidateScore`; a PROMOTED commit lacking
   either was neither passed nor failed — it was invisible to the check. An unauditable promotion
   should fail verification, not pass by omission.

3. **[Found by independent adversarial critique of the first-drafted fix for (1)/(2), before
   shipping.]** A verified Ed25519 signature only proves a receipt's *payload* is internally
   consistent — it does not prove the payload is attached to the *right* commit. `run.ts` signs
   `{kind:'candidate', id, target, verdict, primaryDelta}` (root: `{kind:'root', root}`). Neither the
   pre-existing `chain` receipts check nor the new `all_commits` check cross-verified a
   `LineageCommit`'s own `id`/`verdict` fields against what its signed payload actually claims. A
   REJECTED commit's outer `verdict` could therefore be flipped to `PROMOTED` (receipt splicing)
   without invalidating `verifyReceipt` — a gap in the **pre-existing** chain check too, not only the
   new ledger check.

## Decision

1. Added `allCommitsReceipts` to `ReplayVerdict.checks`: every entry in `bundle.all_commits` must
   carry a receipt that verifies, on the same terms as `chain`.
2. `gateReExecutes` now fails (rather than silently skips) a PROMOTED commit missing sealed
   `baselineScore`/`candidateScore`, when a `promotionRule` is supplied for re-execution. Backward
   compatible: unchanged when no rule is supplied (existing fingerprint-only callers unaffected).
3. Added `receiptMatchesCommit()`: cross-checks a commit's own `id`/`verdict` (or, for the root,
   `id`/`kind`) against the fields embedded in its signed receipt payload. Applied to **both** the
   `chain` `receipts` check and the new `allCommitsReceipts` check — closing the verdict-flip /
   receipt-splicing gap everywhere a receipt is checked, not just in the new code path.
4. `flywheel replay`'s CLI output prints the new `allCommitsReceipts` result.

`meetsPromotionRule` (the frozen gate itself) is untouched — this ADR only strengthens the
*verifier*, exactly as ADR-235 did.

## Consequences

- **Trust model strengthened, and now internally consistent.** A tampered or verdict-flipped entry
  anywhere in a `ReplayBundle` — promoted chain or diagnostic ledger — now fails replay. Honest
  bundles are unaffected: `run.ts` always signs `{kind, id, verdict, ...}` and always seals scores on
  non-root commits, so no legitimate producer output changes behavior. Verified directly against
  every `ReplayBundle` committed in this repository (see Test Contract).
- **Scope-honesty preserved, two gaps explicitly NOT closed tonight** (disclosed in the gist's
  Recommended Next Steps, not silently left unstated): (a) `gateReExecutes` still cannot re-check the
  anchor (anti-Goodhart) clause, because `ReplayBundle` doesn't carry `rootAnchor` at all — needs an
  additive schema field, deliberately deferred to keep tonight's diff scoped; (b) `failureReasons` and
  the Score fields beyond `primaryDelta` are not part of the signed payload, so a bundle editor who
  cannot forge signatures can still alter a rejected candidate's *displayed* cost/reason without
  failing replay — closing this changes `run.ts`'s signed-payload shape and needs a compatibility plan
  for bundles already committed under the old shape.
- **No breaking change to any existing consumer.** `ReplayVerdict.checks` gained one field
  (additive); nothing reads or type-checks against an exact/closed set of check keys.

## Alternatives Considered

- **Sign `failureReasons`/Score fields now, instead of deferring.** Rejected for tonight: changes
  `run.ts`'s payload shape, which would need re-signing (or a versioned payload) for compatibility
  with the 4 real bundles already committed in this repo — a larger, less-reviewable diff than the
  <300-line target. Filed as a disclosed follow-up instead.
- **Require an anchor field in `ReplayBundle` tonight, to close finding (from Alternatives above) the
  critic's anchor-reexecution gap.** Rejected for the same reason: an additive-but-nontrivial schema
  change, better scoped as its own hypothesis/candidate on a future night rather than folded into an
  already-two-part fix.

## Test Contract

- `packages/flywheel/__tests__/units.test.ts`: 52/52 passing (was 47); 8 new tests (4 for
  `allCommitsReceipts` incl. the tamper + verdict-flip cases, 2 for the missing-sealed-scores
  `gateReExecutes` hardening + its backward-compat counterpart, plus 1 pre-existing fixture corrected
  to sign a `verdict` field matching what `run.ts` actually signs — it had been masking exactly the
  gap the critic found).
- Before/after repro: with the fix stashed, all 4 new/changed assertions targeting the fix fail
  exactly as predicted (non-vacuous); restored, 52/52 green.
- Real-bundle regression: `packages/radio/.radio-flywheel/replay-bundle.json`,
  `kimi-k3-harness/.harness/flywheel/replay-bundle.json`,
  `packages/darwin-mode/bench/swebench/proof-bundle-swebench.json`,
  `experiments/signal-flywheel/bundle.json` — all four still PASS post-fix, `allCommitsReceipts: true`
  on every one.
- `tsc --noEmit` clean; full repo `npm run build` clean.

## References

- ADR-235: Independent re-executing verifiers + honest-null replay for flywheel proof bundles.
- RFC 6962 (Certificate Transparency) §5.1–5.3 — a monitor must verify every logged entry, not an
  accepted subset, to audit a log at all.
- Sigstore Rekor (`docs.sigstore.dev/logging/overview`) — the same full-log verification model.
- Zhao, Shoaib, Hoang, Hassan, "Rethinking Tamper-Evident Logging," ACM CCS 2025 (arXiv:2509.03821) —
  completeness of the whole log as a first-class tamper-evident-logging property.
- Jamshidi, Nafi, Dakhel, Khomh, Hamdaqa, "Verifiable Manifest Signing and Transparency Enforcement
  for Secure MCP-Based LLM Pipelines," arXiv:2601.23132 (Jan 2026) — the closest direct 2026 parallel:
  an MCP-manifest transparency log with the identical accepted-only asymmetry.
- Issue #204, `docs/dream-cycle/2026-08-16-gist.md` — full research + evaluation receipt.
