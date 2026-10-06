# ADR-319: Trusted-signer allowlist for `verifyReplayBundle` (closing ADR-274's disclosed key-trust gap)

- **Status**: Accepted (implemented)
- **Date**: 2026-10-06
- **Deciders**: MetaHarness Dream Cycle (autonomous nightly research), slot 1 (flywheel-promotion)
- **Tags**: flywheel, replay, verifier, receipts, provenance, key-trust, metaharness
- **Extends**: ADR-235 (independent re-executing verifiers), ADR-274 (replay consolidation and chain
  binding), ADR-271 (AVO receipts as flywheel-gate evidence — the sibling allowlist this ADR mirrors)
- **Related**: PR #368 (2026-10-01, unmerged) — most recent prior flywheel-promotion night, unrelated
  float-comparison fix in `multigeneration-proof.ts`, not touched here

## Context

`packages/flywheel/src/replay.ts`'s `verifyReplayBundle()` exists so an independent reviewer can
establish trust in a self-improvement promotion lineage with **zero trust in the producer** (ADR-233/
234/235). It checks: receipt signatures, lineage reconstruction to root, chain contiguity, that every
chain node is actually a promotion, gate-fingerprint pinning, live gate re-execution on sealed scores,
full-ledger receipt coverage, and sealed-field/chain-shape tamper-evidence (ADR-274).

ADR-274 (2026-09-01) explicitly disclosed, as an out-of-scope residual gap:

> `verifyReceipt` checks a receipt's signature against its own *embedded* public key; nothing in
> `ReplayBundle`/the CLI pins an expected/trusted key across the bundle, so an attacker could in
> principle self-sign an entirely fabricated bundle with a fresh keypair. ... a distinct, larger
> follow-up (key-trust/allowlist design, analogous to meta-llm's `FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON`
> per ADR-271) — not attempted here.

Tonight's research (parallel Deep Researcher + Architecture Reviewer fan-out) independently re-derived
and confirmed this exact gap is still live 35 nights later, and found the precedent to mirror already
shipped one package over: `packages/avo/src/flywheelGate.ts`'s `gateTrustedKey`/
`FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON` contract (ADR-271), which exists specifically because "a self-signed
receipt under a throwaway key is a CLAIM with a signature, exactly what ADR-249 F-P4 rejects." That
contract protects the AVO→gateway path; flywheel core's own `verifyReplayBundle` — the function this
repo's README and every `metaharness flywheel replay` invocation call "independent verification" — never
adopted the same discipline for itself.

**Concrete exploit, verified tonight**: generate a fresh Ed25519 keypair with no relation to any real
producer; fabricate an entire `ReplayBundle` (root commit, lineage, scores, `lift_curve`); self-sign
every commit with the fresh key. `verifyReplayBundle(bundle)` returns `pass: true` — every check
(`receipts`, `allCommitsReceipts`, `sealedFieldsAuthentic`, `gateReExecutes`) passes, because all of them
ask "is this bundle internally self-consistent," never "was it signed by someone I trust."

## Decision

1. Add an opt-in `opts.trustedPublicKeys?: readonly string[]` parameter to `verifyReplayBundle`. When
   supplied, every receipt in the bundle — both the promoted `chain` and the full `all_commits`
   diagnostic ledger, matching `allCommitsReceipts`' existing coverage convention — must carry a
   `publicKey` on the list, or verification fails with a new `trustedSigner` check and failure reason.
2. **Omitted is unchecked, not "distrust everything."** Matches the existing `gateUnchanged`/
   `pinnedGateFingerprint` convention: an option a caller doesn't pass changes nothing. Byte-identical
   behavior for every bundle verified without the option, confirmed against all 7 real committed
   `ReplayBundle`/proof-bundle files in the repo (see Consequences).
3. **An empty array (`trustedPublicKeys: []`) is also treated as "not supplied."** The guard checks
   `.length === 0`, not bare truthiness — an empty array is truthy in JS, and this exact shape
   (`pairedOutcomes: []` silently meaning "reject everything" instead of "nothing supplied") already
   caused a real regression in this package on 2026-09-16 (#319/#320, coincidentally the same ADR number
   slot as this one in an earlier, now-superseded numbering — unrelated collision, confirmed via
   `INDEX.md`). The same mistake is guarded against here from the start, with a regression test.
4. Wire a repeatable `--trusted-key <base64>` CLI flag into `metaharness flywheel replay`, so the
   allowlist is actually usable by a human reviewer at the command line, not just the library API.

## Consequences

- **New capability, not a behavior change by default.** A caller who wants "was this definitely signed by
  a key I recognize" can now ask the question; a caller who doesn't is byte-for-byte unaffected.
- **Closes a real forgery vector when used.** Verified via 5 new unit tests: a self-signed fabricated
  bundle passes today with no allowlist (the disclosed gap, now explicit and tested rather than merely
  documented in prose); fails once a non-matching allowlist is supplied; passes once the real signer's
  key is on it; the check covers `all_commits` (an untrusted-signed REJECTED entry also fails); an empty
  allowlist is a no-op.
- **No behavioral change for any honestly-produced, unchecked bundle.** Verified directly against all 7
  real committed bundles in the repo (`packages/radio/.radio-flywheel/replay-bundle.json`,
  `kimi-k3-harness/.harness/flywheel/replay-bundle.json`, `packages/darwin-mode/bench/swebench/
  proof-bundle-swebench.json`, `packages/evals-math/bench/proof-bundle-gsm8k*.json` ×3,
  `experiments/signal-flywheel/bundle.json`) — all still `ACCEPTANCE: PASS`, unchanged, with and without
  the new CLI flag omitted.
- **Residual gap, disclosed not fixed**: this ADR does not make the allowlist mandatory anywhere, and
  does not add an environment-variable-backed default allowlist (unlike avo's gateway-side
  `FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON`, which is read automatically). A reviewer who doesn't know to pass
  `--trusted-key` gets no protection — the capability exists but isn't on by default. Making it
  default-on would be a larger, riskier change (what's the default allowlist source? does it break every
  existing honest-null/CI replay check that doesn't pin a key today?) deliberately deferred to a future
  night given tonight's bias toward a small, reviewable diff while the PR backlog is unresolved (see
  Alternatives Considered).

## Alternatives Considered

- **Make key-trust mandatory (fail closed when no allowlist is supplied).** Rejected for tonight: this
  would be a breaking change to every existing caller and CI check that calls `verifyReplayBundle`
  without an allowlist (confirmed callers: `cli.ts`'s `replay`/`run` verbs, the package's own test
  suite). A breaking default-behavior change to the core verification primitive, while 8 other
  dream-cycle PRs sit unreviewed, is exactly the kind of large, risky diff STEP 1.1's zero-merge bias
  argues against adding to the pile.
- **Read a default allowlist from an environment variable** (mirroring avo's gateway-side
  `FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON`). Rejected for tonight: flywheel core is a library + CLI, not a
  long-running gateway process — an env-var-backed implicit default is a bigger design surface (where
  does it live for a one-shot CLI invocation? does it leak into every downstream `evals-*`/`autogenous`
  importer?) than an explicit, caller-supplied parameter. A good candidate for a future night once this
  primitive has been in use and reviewed.

## Test Contract

- `cd packages/flywheel && npx vitest run` → 148/148 passing (baseline 143/143, +5, 0 regressions).
- Non-vacuous: all 5 new tests fail (`checks.trustedSigner` / `pass` is `undefined`, not `false`/`true`)
  against the pre-fix source (`git stash` on `replay.ts`+`cli.ts` alone, tests kept).
- Live CLI proof: `metaharness flywheel replay experiments/signal-flywheel/bundle.json --trusted-key
  <real-signer-key>` → PASS; same command with a bogus key → `FAIL (trustedSigner)`, exit code 1; same
  command with no `--trusted-key` → PASS, identical to pre-change output modulo the new, clearly-labeled
  "skipped (no --trusted-key)" status line.
- All 7 real committed `ReplayBundle` files re-verified unchanged (`ACCEPTANCE: PASS`, no `--trusted-key`
  supplied).
- `tsc` clean (`npm run build --workspace=@metaharness/flywheel`).

## References

- ADR-274 (2026-09-01) — the gap this ADR closes, disclosed 35 nights ago.
- ADR-271 (2026-08-xx) — `packages/avo/src/flywheelGate.ts`'s `FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON`
  allowlist, the proven pattern this ADR mirrors one package over.
- `docs/dream-cycle/2026-10-06-gist.md` — tonight's full research report and evaluation receipt.
