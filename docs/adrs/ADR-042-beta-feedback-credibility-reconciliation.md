# ADR-042: Beta-feedback triage — credibility reconciliation (issue #4 / AQE fleet)

**Status**: Accepted
**Date**: 2026-06-15
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-038/039/040 (DRACO), ADR-027 (CLI↔Studio), issue #4

---

## Context

External beta feedback from the AQE fleet ([agentic-qe], issue #4) ran an
adversarial code-quality pass + a live build/test reproduction and filed a
prioritized, file:line-evidenced report. Verdict: a genuinely novel, well-
architected tool whose **generator (the real product) is clean and well-tested**
with no shipping-blocker defect — but whose **docs oversell it**, with one
headline claim that contradicts our own measurements. The critique is fair and
largely correct; this ADR records the triage + decisions rather than re-arguing.

The throughline: our engineering (ADR discipline, the DRACO negative result, the
no-exec analyzer, default-deny MCP governance, `mcp-scan`) is strong; the
**credibility layer (docs)** lags the code. Fix the docs to match the code.

## Decision

Accept the report. Triage:

### P0 — credibility blockers (fix now)

1. **DRACO claim retraction — DONE.** `README` claimed "a tuned harness beats a
   vanilla model … measured." Our own ADR-038 measured the opposite
   (`vanilla 0.7143 > fusion 0.6472 > harness 0.6126`). Rewrote the README to
   state the negative result + the *real* measured win (cost: ADR-039/040). The
   reviewer is right that publishing the negative result is a strength — the
   README just had to match it.
2. **`npm test` fresh-clone failure — DONE.** Added root `pretest: npm run build`
   so the workspace `dist/` exists before `-ws test` runs.
3. **Status story — pick "v0.1.x beta."** OVERVIEW ("pre-implementation") vs
   README ("production-ready") vs USAGE ("Phase 1") will be reconciled to a
   single "v0.1.x beta" status line. (doc sweep, follow-up PR)
4. **CLI↔Studio parity — write the test or downgrade the claim.** ADR-027 names
   `apps/web-ui/__tests__/parity.test.ts` as the sole drift guard; it does not
   exist. Either add a real cross-package `Buffer.equal` scaffold-parity test or
   downgrade the wording to "behaviorally equivalent." (follow-up)
5. **Example-README fabricated transcripts — generate or mark illustrative.**
   The `trading`/`legal`/`research` wrappers show invented `harness doctor`
   output + README-only "safety." Regenerate from real `--scaffold` output or
   label illustrative; push safety into template code. (follow-up; partially
   overlaps the wrapper fixes already shipped)

### P1 — adoption frictions (roadmap)

6. Right-size the kernel narrative (JS-reachable surface is `kernelInfo`/
   `mcpValidate`/`version`; witness degrades to `{valid:true}` when the kernel is
   absent — `publish.ts:106` TODO). Qualify or wire it. Aligns with ADR-002a's
   pure-JS-fallback honesty.
7. Single source of truth for counts (packages/hosts/subcommands drift; stale
   Status table; CHANGELOG stops at iter 102). Generate counts from the tree.
8. Bury the ruflo lineage from the adopter path; add a "where am I in the stack"
   diagram (`metaharness` emits → `harness` → users run `harness`).
9. Prove `harness upgrade` on a messy hand-edited harness (the 3-way merge is the
   make-or-break "own it and still get updates" promise).

### P2 — polish

10. Close the two generator branch gaps (`publish.ts pinJson` non-2xx;
    `upgrade.ts --conflict=rej .rej` write); de-dup `runWizard`'s pick-loops;
    wire `harness verify` + `mcp-scan` as CI gates; label exotic features
    experimental; trim the keyword SEO dump.

### Collaboration

The AQE **adversarial blind-refuter** as an optional per-vertical output gate is
a strong idea and a *direct candidate rebuttal to the DRACO result*: a refuter
that catches unsupported claims is exactly "structure that earns its cost." It
maps onto ADR-038 arm-1 (verify→prune) — which failed because its verifier could
not re-fetch URLs. A refuter with retrieval might clear the bar the prune pass
could not. Worth a measured arm; tracked for the routing/scorecard work.

## Consequences

- Docs become a faithful map of the code; the one false headline is retracted in
  favour of the honest, more interesting result (cost-optimal routing).
- P0 #1/#2 land immediately; #3–#5 + P1/P2 are tracked follow-ups, each with the
  measured-win discipline (no new claim without a test or a measurement).
