# ADR-166: Human Review Gates — review only the uncertain edge

**Status**: Proposed — reference implementation in `@metaharness/projects`
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-HUMAN-GATE`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: Route a Darwin run to a human ONLY when it is genuinely uncertain (high-risk file, security-sensitive change, over budget, low confidence, or statistically ambiguous benchmark); keep every other path fully deterministic and automatic.
**Related**: ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces + allowlist), ADR-072 (frozen scorer/promotion), ADR-073 (archive + selection), ADR-074 (ruVector memory), ADR-076 (parent-vs-child benchmark), ADR-079 (SGM statistical gates + risk budget), ADR-082 (expected gains + effective-performance), ADR-153 (agentic-loop architecture), ADR-155 (Darwin Shield), ADR-156 (umbrella — "mutate structured policies, not prompts"), ADR-158 (trace/cost ledger), ADR-160 (escalation scheduler), ADR-164 (fail-closed safety rails), ADR-165 (opportunity scanner — supplies the risk score)

> We borrow the **human-gated deterministic verification** pattern from industrial robotics agents: an LLM does the contextual reasoning, but verification, sequencing, and physical execution stay deterministic, and a human inspects + re-verifies before anything irreversible happens. We copy the pattern, not the product — there is no robot here, and we are not adopting any specific vendor's PLC stack. Grafted onto Darwin Mode, the "physical execution" is a *promotion*: admitting an evolved harness into the lineage. The model reasons; the oracles verify (deterministic); the scheduler sequences (deterministic); the bootstrap promotes (deterministic); and a human is consulted only at the uncertain edge. The thesis holds: **the foundation model stays frozen; the harness evolves; the proof is in replay** — and **Darwin Mode mutates structured policies, not prompts.** A `ReviewGate` is itself a structured policy, not a prompt.

## Context

Two failure modes bracket any review process. Review *everything* and humans become the bottleneck — trust erodes, throughput collapses, and the "self-improving" claim is hollow because a human is in every loop. Review *nothing* and a low-confidence or statistically-ambiguous promotion slips into the lineage, where ADR-073's archive will faithfully propagate the mistake. The robotics-agent pattern resolves this: let the model reason freely, but keep verification deterministic and reserve the human for the cases the deterministic layer itself flags as uncertain.

Darwin Mode already has the deterministic layer the pattern needs:

1. **Verification is deterministic** — `semgrep-oracle.ts` / `fuzz-oracle.ts` produce replayable verdicts (`Finding.verdict`, `RunMetrics.reproduced`); `policy.ts::detectUnsafe` is a pure content gate.
2. **Promotion is statistical and seeded** — `stats.ts::bootstrapDelta` returns `{ meanDelta, lower95, upper95, promote, pValue }` from a seeded (mulberry32) paired bootstrap, and `decidePromotion` only admits a child when `lower95 > 0` and there is no unsafe regression. Crucially, **a bootstrap CI that straddles zero (`lower95 <= 0 <= upper95`) is the definition of an *ambiguous* benchmark** — a result the math itself cannot call.
3. **Confidence is a first-class field** — `Finding.confidence: number` (0..1).

What is missing is the routing rule that turns these signals into "ask a human" vs "decide automatically." This ADR proposes **Human Review Gates**: a structured policy that escalates only the uncertain edge and leaves everything else deterministic.

Distinct from ADR-164 (fail-closed safety rails): those rails *reject without a human* — exploit content, `exploitCodeAllowed !== false`, out-of-scope targets are refused unconditionally (`policy.ts::gateOutputs`, `requireScope`). Review gates do not reject; they *ask*. A safety-rail violation never becomes a review item, and a review item is never a safety-rail bypass.

## Decision

Add a **proposed** module `packages/darwin-mode/src/security/review-gate.ts` (name proposed). It defines a structured gate policy and a pure routing function. The LLM reasons upstream; the gate is deterministic.

```ts
/** Why a run was escalated to a human (empty array => fully automatic). */
export type GateTrigger =
  | 'highRiskFileTouched'    // a path on the high-risk list was modified
  | 'securitySensitiveChange'// auth / crypto / scope / safety-relevant code changed
  | 'costOverBudget'         // run cost (RunMetrics.costUnits, ADR-158) > budget
  | 'lowConfidence'          // a Finding.confidence < confidenceThreshold
  | 'ambiguousBenchmark';    // bootstrap CI straddles zero (stats.ts)

/** The structured review policy. Tunable thresholds, no prompts (ADR-156). */
export interface ReviewGate {
  /** Paths whose modification always escalates (deploy/secrets/CI/etc.). */
  highRiskFiles: string[];
  /** Globs/markers for security-sensitive code (auth, crypto, scope, policy.ts). */
  securitySensitiveGlobs: string[];
  /** Cost ceiling in cost units; over it -> escalate (ADR-158/160). */
  costBudget: number;
  /** A finding below this confidence escalates. Compared to Finding.confidence. */
  confidenceThreshold: number; // e.g. 0.6
}

/** Everything the gate needs to decide, all of it deterministic structured data. */
export interface ReviewContext {
  changedFiles: string[];
  /** RunMetrics.costUnits for this run (ADR-158 cost ledger). */
  costUnits: number;
  /** The run's findings (carries Finding.confidence + verdict). */
  findings: Finding[];
  /** The promotion verdict from stats.ts::bootstrapDelta / decidePromotion. */
  bootstrap: BootstrapResult; // { meanDelta, lower95, upper95, promote, pValue, samples }
}

export type Routing =
  | { decision: 'auto'; triggers: [] }
  | { decision: 'human'; triggers: GateTrigger[] };

/**
 * FROZEN, deterministic routing. Pure function — no model, no clock, no I/O — so
 * the same (gate, context) always routes the same way (the determinism test). A
 * human is asked ONLY when at least one trigger fires; otherwise the run rides
 * the deterministic rails (oracles + scheduler + bootstrap) to an automatic
 * decision. NB: this NEVER overrides a fail-closed safety rail (ADR-164) — those
 * have already rejected before routing is reached.
 */
export function routeReview(gate: ReviewGate, ctx: ReviewContext): Routing {
  const triggers: GateTrigger[] = [];

  if (ctx.changedFiles.some((f) => gate.highRiskFiles.includes(f)))
    triggers.push('highRiskFileTouched');

  if (ctx.changedFiles.some((f) => matchesAny(f, gate.securitySensitiveGlobs)))
    triggers.push('securitySensitiveChange');

  if (ctx.costUnits > gate.costBudget) triggers.push('costOverBudget');

  if (ctx.findings.some((x) => x.confidence < gate.confidenceThreshold))
    triggers.push('lowConfidence');

  // The statistical core of the gate: a CI that straddles zero is, by the
  // bootstrap's own admission, an undecidable promotion. lower95 <= 0 <= upper95.
  if (ctx.bootstrap.lower95 <= 0 && ctx.bootstrap.upper95 >= 0)
    triggers.push('ambiguousBenchmark');

  return triggers.length === 0
    ? { decision: 'auto', triggers: [] }
    : { decision: 'human', triggers };
}
```

The load-bearing tie is `ambiguousBenchmark`. `decidePromotion` (stats.ts) already refuses to promote when `lower95 <= 0` — but "refuse to promote" and "this is uncertain" are different statements. A CI fully below zero (`upper95 < 0`) is an *unambiguous* rejection and stays automatic; a CI that *straddles* zero is genuine ambiguity and is exactly where a human adds signal. So the gate fires on straddle, not on every non-promotion. The clear cases — confident promote (`lower95 > 0`) and confident reject (`upper95 < 0`) — never reach a human.

Deterministic-everything-else, restated against real modules: the model *reasons* (proposes mutations, drafts patches/advisories via the disclosure-writer); verification is the oracles (`semgrep-oracle.ts`, `fuzz-oracle.ts`); sequencing is the escalation scheduler (ADR-160); promotion is the seeded bootstrap (`stats.ts`). None of those four are a model call, so the non-gated path is reproducible from a clean checkout. The human sees only the uncertain edge.

Expected impact (HYPOTHESES, to be validated, not assumed): human-review burden drops sharply while escaped defects do not rise; trust improves; the system fits regulated workflows where "a human signed off on the uncertain ones" is auditable. The acceptance target — review rate halves *without* increasing escaped defects — is a hypothesis tested by the simulation below, not a guarantee.

## Consequences

**What changes.** Humans stop reviewing confident, oracle-verified, in-budget promotions. They review the uncertain edge: high-risk/security-sensitive diffs, over-budget runs, low-confidence findings, and straddling-CI benchmarks. The escalation reason set (`GateTrigger[]`) is recorded on every run, so "why did a human see this?" is always answerable from the trace ledger (ADR-158).

**What does not change.** The foundation model stays frozen. Fail-closed safety rails (ADR-164) are untouched and still reject unconditionally — review gates sit *after* the rails and only handle the survivors that are uncertain rather than unsafe. The frozen scorer (ADR-072) and the seeded bootstrap (ADR-079/`stats.ts`) are unchanged; the gate reads their output, it does not alter the math. The gate is a structured policy (ADR-156), not a prompt.

**What hurts.** The gate inherits the bootstrap's sample-size limits: with few corpus repos the CI is wide and *more* runs straddle zero, so a small corpus escalates more than a large one (correct behaviour, but it raises review volume early). Thresholds are judgement calls — `confidenceThreshold` too high floods humans; too low lets shaky findings through automatically. Mis-listing `highRiskFiles` / `securitySensitiveGlobs` either over-escalates (annoyance) or under-escalates (risk). And the 50% reduction is a *hypothesis*: on a corpus that is mostly uncertain, the gate cannot halve review without lowering thresholds, which would trade burden for escaped defects — exactly the trade the acceptance test forbids.

## Alternatives Considered

1. **Review every promotion (status quo / max-trust).** Rejected: humans become the bottleneck; the self-improvement claim collapses and throughput is gated on people.
2. **Review nothing — trust the bootstrap fully.** Rejected: a straddling-CI promotion is, by the bootstrap's own definition, undecidable; auto-deciding it propagates noise into the archive (ADR-073). Some uncertainty genuinely needs a human.
3. **LLM-judged "should a human look at this?"** Rejected: non-reproducible and violates ADR-156. Routing must be a pure function of structured signals so the determinism test can pin it.
4. **Fold review into the safety rails (ADR-164).** Rejected: rails *reject*, gates *ask*. Merging them would either turn uncertainty into hard rejection (over-blocking) or weaken the rails into advisory (under-blocking). They must stay separate: reject-without-human vs ask-a-human.
5. **Escalate on any non-promotion (`lower95 <= 0`).** Rejected: a CI fully below zero is an unambiguous reject and should auto-decide. Escalating it wastes human attention on cases the math already settled; only the *straddle* is ambiguous.

## Test Contract

Operationalizes the acceptance test ("human-review rate drops by 50% WITHOUT increasing escaped defects") plus the routing and determinism guarantees.

- **`reviewGate.routingMatrix`** — For each `GateTrigger`, construct a `ReviewContext` that fires *only* that trigger and assert `routeReview` returns `decision: 'human'` with exactly that trigger. Then a fully-clean context (in-budget, all `confidence >= threshold`, `lower95 > 0`) asserts `decision: 'auto'` with `triggers: []`. Includes the boundary cases: `upper95 < 0` (confident reject) ⇒ `auto`; `lower95 <= 0 <= upper95` (straddle) ⇒ `human` via `ambiguousBenchmark`.
- **`reviewGate.fiftyPercentReductionSim`** — Replay a labeled stream of runs (each tagged "real defect" or "clean") through `routeReview`. Compute the human-review rate vs a review-everything baseline and the escaped-defect rate (real defects that took the `auto` path). Assert review rate <= 50% of baseline AND escaped-defect rate does not exceed the review-everything baseline. (Directly the acceptance test; the 50% is a hypothesis the corpus may or may not support, and the test records which.)
- **`reviewGate.nonGatedDeterminism`** — For contexts that route `auto`, run the downstream verification + bootstrap path twice with the same seed and assert byte-identical `BootstrapResult` and verdict. Proves the non-gated path is fully deterministic (no hidden model call).
- **`reviewGate.routeIsPure`** — Call `routeReview(gate, ctx)` repeatedly (and on a deep-cloned `ctx`) and assert identical `Routing` every time; mutate nothing. Locks the pure-function contract.
- **`reviewGate.railsTakePrecedence`** — A context whose findings would trip a fail-closed safety rail (ADR-164, e.g. `exploitCodeAllowed !== false` or `detectUnsafe` hit) is rejected by the rail *before* `routeReview` is consulted; assert it never appears as a human-review item. Keeps "reject-without-human" and "ask-a-human" disjoint.

## Reference implementation

A dependency-free, deterministic reference of this ADR lives in `@metaharness/projects` (committed this session): `packages/projects/src/review-gates.ts` (with its test and `bench/review-gates.bench.mjs`). It implements `routeReview` (escalating to a human only on high-risk file, security-sensitive change, over-budget, low-confidence, or ambiguous-bootstrap signals) plus `simulateReviewStream`. The package as a whole has 117 passing tests. The synthetic bench is a deterministic simulation; its receipt (`packages/projects/bench/results/review-gates.json`) shows ~52.5% fewer human reviews, and escaped defects are reported HONESTLY — the signal-less minority can still escape, because risk-based gating is not a free lunch — rather than rigged to zero.

## References

- Human-gated deterministic verification — industrial robotics agent pattern: LLM for contextual reasoning, deterministic verification/sequencing/execution, human inspection + re-verification before irreversible action (borrowed pattern; no product adopted).
- ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces + allowlist), ADR-072 (frozen scorer/promotion), ADR-073 (archive + selection).
- ADR-074 (ruVector memory), ADR-079 (SGM statistical gates + risk budget), ADR-082 (expected gains + effective-performance).
- ADR-153 (agentic-loop architecture), ADR-155 (Darwin Shield — `Finding.confidence`, oracles, `detectUnsafe`), ADR-156 (umbrella — mutate structured policies, not prompts).
- ADR-158 (trace/cost ledger — `RunMetrics.costUnits`), ADR-160 (escalation scheduler — deterministic sequencing), ADR-164 (fail-closed safety rails — reject without a human).
- ADR-165 (opportunity scanner — supplies `riskScore`, the upstream risk signal).
- Real modules: `packages/darwin-mode/src/security/{stats.ts (bootstrapDelta/decidePromotion), policy.ts (detectUnsafe/gateOutputs/requireScope), scoring.ts, swarm.ts, semgrep-oracle.ts, fuzz-oracle.ts, types.ts}`.
