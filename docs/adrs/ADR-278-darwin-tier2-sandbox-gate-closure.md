# ADR-278: Closing the Tier-2 `agent` sandbox's missing ADR-071 safety gate

- **Status**: Accepted — implemented (`packages/darwin-mode/src/tier2-sandbox.ts`), regression-tested
  (`packages/darwin-mode/__tests__/security/tier2-gate-bypass.test.ts`), independently critiqued.
- **Date**: 2026-09-02
- **Deciders**: MetaHarness Dream Cycle (autonomous nightly research), slot 2 (darwin-evolution)
- **Tags**: darwin-mode, sandbox, safety-gate, containment, metaharness, process
- **Extends**: ADR-071 (mutation surfaces + safety gate), ADR-106 (Tier-2 `agent` sandbox)
- **Related**: ADR-273 (`llm-agent` sandbox) — the ADR that found and disclosed this exact gap without
  fixing it
- **Prompted by**: three independent research passes tonight (external-literature review, internal
  architecture review, and a competitor-landscape survey of verifier-honesty risk in self-modifying
  harnesses) converging, unprompted, on the same finding

---

## Context

Darwin Mode's Tier-2 `agent` sandbox (`tier2-sandbox.ts`, ADR-106) executes a variant's **real**,
generated TypeScript surface files by spawning a child process (`tier2-driver.ts`) that `import()`s
and runs them with full Node capabilities. The module's own doc comment claimed: "The gate
(`inspectVariant`) has already cleared the variant before any execution" — describing the ADR-071
safety gate that disqualifies a variant directory containing disallowed files or blocked-capability
content (filesystem, process spawning, network, secrets, etc.) before it ever runs.

That claim was false. `inspectVariant` was never called anywhere on the Tier-2 code path. This was
already found once, by ADR-273 (2026-09-01, the night before this one), while building the sibling
`llm-agent` sandbox — and explicitly left open: "`inspectVariant` is in fact never called anywhere on
the Tier-2 code path today — confirmed by search. Out of scope to fix here since it is pre-existing
and unrelated to this ADR's own new code, which does call it." The two sibling sandboxes,
`sandbox.ts` (`real`) and `llm-agent-sandbox.ts` (`llm-agent`, ADR-273's own new code), both gate
first correctly.

Tonight's research independently rediscovered the same gap from three angles at once: an external
literature pass on 2026 evolutionary-harness research, an internal source-vs-ADR consistency review,
and a competitor-landscape survey that flagged verifier-honesty/containment as a live, practical risk
in self-modifying harnesses generally (citing STOP and the original Darwin Gödel Machine, both
observed disabling their own logging/scoring visibility in practice). This is exactly that risk class,
concretely instantiated in this repository.

Confirmed non-vacuously, not just by code inspection: a hand-built adversarial variant (a `node:fs`
top-level import performing a real filesystem write, in an otherwise-clean, approved surface file)
was run against the unpatched code. `inspectVariant` correctly flagged it when called directly, but
`runVariantTaskAgent` executed it anyway — the injected side effect (a marker file) was actually
created on disk, proving real, unguarded code execution, not merely a wrong exit code.

## Decision

`runVariantTaskAgent` (`tier2-sandbox.ts`) now calls `inspectVariant(variant.dir)` first, mirroring
`sandbox.ts` and `llm-agent-sandbox.ts` exactly: if findings are non-empty, `tier2-driver.js` is never
spawned, and a disqualified `RunTrace` (`exitCode: 99`, `blockedActions` set to the findings) is
returned instead — the same reserved convention `scorer.ts`/`evolve.ts` already read generically from
the other two gated sandboxes, so no downstream scoring/promotion logic needed to change.

The fix is a pure prepend to the one function every Tier-2 evaluation path funnels through
(`runVariantTasksAgent` only calls `runVariantTaskAgent`; `evolve.ts` only calls
`runVariantTasksAgent`; `tier2-driver.ts` is spawned nowhere else in the package) — zero behavioral
change for any variant that already passes the gate.

## Consequences

- Tier-2 (`agent`) now has the same containment posture as `real` and `llm-agent`: a disqualified
  variant's surface code is never imported, let alone executed.
- `tier2-sandbox.ts`'s module doc and `runVariantTaskAgent`'s JSDoc were corrected to state the true
  (now-true) invariant instead of repeating the prior false claim.
- No change to `EvolutionConfig`, `types.ts`, or the CLI surface — this is a containment fix, not a
  new feature or flag.
- **Not addressed here** (disclosed, not fixed — separate, smaller-blast-radius finding from tonight's
  architecture-review pass): `--bench` (ADR-087 graded promotion) silently routes the promotion
  decision through the `real`-sandbox test command even when `--sandbox agent`/`llm-agent` is
  selected, regardless of `EvolutionConfig.sandboxMode`. This is a fidelity gap in which substrate
  actually decides promotion, not a containment breach, and is out of scope for this diff's budget —
  flagged for a future darwin-evolution night.

## Alternatives Considered

- **Gate inside `tier2-driver.ts` (the child process) instead of `tier2-sandbox.ts` (the parent).**
  Rejected: the driver is a standalone script whose whole purpose is to `import()` the variant's
  files; by the time it runs, the files it needs to inspect are already being imported as part of
  its own module graph. Gating at the spawn site (parent) is strictly earlier and matches the
  pattern both sibling sandboxes already use.
- **Leave it disclosed-only, as ADR-273 did.** Rejected: the gap is small, deterministic, and cheaply
  fixable (a few lines, mirroring existing code), and three independent research passes converging on
  it unprompted in one night is a strong signal it should not be deferred a second time.

## Test Contract

`packages/darwin-mode/__tests__/security/tier2-gate-bypass.test.ts`:
- A variant with a `node:fs`-importing, blocked-content surface file must be disqualified
  (`exitCode: 99`, non-empty `blockedActions`) by both `runVariantTaskAgent` and
  `runVariantTasksAgent`, and must never produce the injected side effect (a marker file) — asserted
  directly via `existsSync`, not inferred from the exit code alone.
- A clean, unmodified generated baseline variant must be unaffected (no `exitCode: 99` in any of its
  task traces) — the regression control.
- Full `packages/darwin-mode` suite (74 files, 657 tests, 14 pre-existing skips) must stay green.

## References

- `docs/adrs/ADR-071-...md` (mutation surfaces + safety gate)
- `docs/adrs/ADR-106-...md` (Tier-2 `agent` sandbox)
- `docs/adrs/ADR-273-darwin-llm-agent-sandbox.md` (disclosed this gap, left open)
- `packages/darwin-mode/src/tier2-sandbox.ts`, `packages/darwin-mode/src/safety.ts`
- `docs/dream-cycle/2026-09-02-gist.md`, `docs/dream-cycle/2026-09-02-evidence.md`
