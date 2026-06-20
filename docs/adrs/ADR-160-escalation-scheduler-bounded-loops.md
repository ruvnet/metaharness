# ADR-160: Escalation Scheduler — bounded loops, fail-closed

**Status**: Proposed — reference implementation in `@metaharness/projects`
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-SCHEDULER`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: A bounded, fail-closed scheduler for the harness agentic loop — every run terminates under budget with a typed reason; no silent infinite retries
**Related**: ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces + allowlist), ADR-072 (frozen scorer/promotion), ADR-073 (archive + selection), ADR-079 (SGM statistical gates + risk budget), ADR-082 (expected gains + effective-performance), ADR-153 (agentic-loop architecture), ADR-155 (Darwin Shield), ADR-156 (borrowed-pattern integration program), ADR-159 (HarnessSpec — declarative policy)

> We borrow the **structured graph-harness scheduling research** pattern: open-ended agent loops create implicit dependencies, unbounded recovery loops, and mutable history; the recommended discipline is explicit plans, separated planning and recovery layers, and strict escalation protocols. We copy the **pattern**, not any product. The thesis holds throughout — **the foundation model stays frozen; the harness evolves; the proof is in replay** — and the scheduler is itself a structured policy, consistent with **Darwin Mode mutates structured policies, not prompts**: budgets and escalation rules are typed fields, not prompt instructions.

## Context

`packages/darwin-mode/src/security/agentic.ts` already implements a bounded ReAct-style loop over a restricted, read-only/oracle-only tool surface (`list_sites · read_site · grep · run_analyzer · run_fuzzer · assert_invariant · submit_finding`). It carries a `maxSteps` budget (default 40) and respects it as a hard bound (`if (stepsUsed >= policy.maxSteps) break;`). The genome (`types.ts` `HarnessGenome`) clamps `retryBudget ∈ [1,6]`, `reviewerCount ∈ [1,5]`, `fuzzBudgetSeconds ∈ [10,600]` via `genome.ts BOUNDS`, and `scoring.ts` exposes `COST_BUDGET = 20` and `TIME_BUDGET = 5` as the deterministic cost/time scale used by `fitness()`.

What is missing is a **single, explicit scheduling policy** that ties these scattered limits together and guarantees three properties for *every* run, not just the agentic loop's step counter:

1. **No infinite loops.** Retries, frontier escalations, context growth, and reviewer passes must each have a hard cap. Today `maxSteps` caps the agentic tool loop, but retry/escalation/reviewer growth elsewhere (`swarm.ts`, `evolve.ts`) are bounded only by genome clamps, not by a unified, audited scheduler.
2. **Typed termination.** Every exit must carry a machine-readable reason. Today a loop that exhausts its step budget simply `break`s; the reason is implicit.
3. **Fail-closed on security uncertainty.** When the safety layer (`policy.ts` `detectUnsafe`) is uncertain, the run must stop and refuse, never "try once more." This ties to ADR-079's cumulative risk budget and the immutable `safetyProfile: 'strict-defensive'`.

The borrowed research is blunt about why: unbounded recovery loops are the fastest way to burn money and the easiest place for a self-modifying harness to accumulate unbounded risk. The spec to expand (verbatim intent): *Escalation Scheduler — never allow infinite agent loops. Rules: max retries per node, max frontier escalations, max context growth, max reviewer passes, mandatory fail-closed on security uncertainty. Unbounded loops are the fastest way to burn money. Expected impact: 10–35% cost reduction on failing tasks; major safety improvement. Acceptance test: no task can exceed budget; every failure exits with a typed reason; no silent infinite retry loops.* The 10–35% cost-reduction figure is a **hypothesis to validate**, not an established fact; the Test Contract operationalizes the acceptance test.

## Decision

Introduce a **proposed** module `packages/darwin-mode/src/security/scheduler.ts` (new; clearly proposed) defining a typed `SchedulerPolicy`, a typed `TerminationReason` enum, and a `schedule()` driver that wraps the agentic loop and the swarm so that every node transition is checked against the policy and every exit is typed. The scheduler enforces — it never grades; grading stays frozen in `scoring.ts`.

```ts
// PROPOSED — packages/darwin-mode/src/security/scheduler.ts
import { COST_BUDGET, TIME_BUDGET } from './scoring.js';
import type { HarnessGenome } from './types.js';

/** The bounded scheduling policy. Mirrors/extends genome BOUNDS + scoring budgets. */
export interface SchedulerPolicy {
  /** Hard cap on retries of any single node (mirrors genome.retryBudget 1..6). */
  maxRetriesPerNode: number;
  /** Hard cap on cheap→frontier escalations across a whole run. */
  maxFrontierEscalations: number;
  /** Max ratio the retrieved context may grow vs. its first assembled size. */
  maxContextGrowthRatio: number;
  /** Hard cap on reviewer passes (mirrors genome.reviewerCount 1..5). */
  maxReviewerPasses: number;
  /** Cumulative cost units the run may spend (ties to scoring.COST_BUDGET=20). */
  costBudget: number;   // default COST_BUDGET
  /** Cumulative time-to-finding units the run may spend (ties to TIME_BUDGET=5). */
  timeBudget: number;   // default TIME_BUDGET
  /** MANDATORY: on any security uncertainty, stop and refuse. Pinned literal. */
  failClosedOnSecurityUncertainty: true;
}

/** The default, derived from the frozen budgets and the genome's clamps. */
export function defaultSchedulerPolicy(g: HarnessGenome): SchedulerPolicy {
  return {
    maxRetriesPerNode: g.retryBudget,        // already clamped 1..6 by genome.ts
    maxFrontierEscalations: g.reviewerCount,  // bounded by the 1..5 clamp
    maxContextGrowthRatio: 4,
    maxReviewerPasses: g.reviewerCount,
    costBudget: COST_BUDGET,
    timeBudget: TIME_BUDGET,
    failClosedOnSecurityUncertainty: true,
  };
}

/** Every run exits with exactly one of these. No silent termination. */
export enum TerminationReason {
  Success = 'success',
  BudgetExhausted = 'budget_exhausted',     // cost or time budget hit
  MaxRetries = 'max_retries',               // a node retried maxRetriesPerNode times
  MaxEscalations = 'max_escalations',       // frontier escalations exhausted
  ContextOverflow = 'context_overflow',     // context grew past maxContextGrowthRatio
  MaxReviewerPasses = 'max_reviewer_passes',
  SecurityUncertain = 'security_uncertain', // fail-closed on safety uncertainty
}

/** The typed outcome — load-bearing for audit and for the receipt. */
export interface ScheduleOutcome {
  reason: TerminationReason;
  costSpent: number;
  timeSpent: number;
  retries: Record<string, number>;     // per-node retry counts
  escalations: number;
  reviewerPasses: number;
  /** True iff the run halted because the safety layer was uncertain. */
  failedClosed: boolean;
}

/** Per-node budget accounting; throws/returns a typed reason on violation. */
export interface NodeContext {
  nodeId: string;
  costSpent: number;
  timeSpent: number;
}
```

### Behavior

- `schedule()` runs the harness graph (genome- or HarnessSpec-driven, ADR-159) node by node. Before each transition it checks the policy: a node retried `maxRetriesPerNode` times terminates the run with `TerminationReason.MaxRetries`; cumulative cost past `costBudget` (default `COST_BUDGET=20`) yields `BudgetExhausted`; etc.
- **Fail-closed is the default and is non-mutatable.** When the safety layer is uncertain — `policy.detectUnsafe(text)` returns a non-empty reason set on any content the run is about to act on, *or* a finding's `exploitCodeAllowed !== false` — `schedule()` halts immediately with `TerminationReason.SecurityUncertain` and `failedClosed: true`. There is no "retry past a safety doubt" path. This binds to ADR-079's cumulative risk budget: a fail-closed exit spends nothing further and cannot be overridden by local score.
- **No silent infinite retry.** A node that loops without making progress is killed at `maxRetriesPerNode` and exits `MaxRetries`. The `maxSteps` bound already present in `agentic.ts` is subsumed: `schedule()` treats step exhaustion as `BudgetExhausted`.
- Every `ScheduleOutcome.reason` is written into the `BenchmarkReceipt` so the audit trail and replay both carry the typed reason.

The policy fields deliberately mirror the genome's existing clamps (`retryBudget`, `reviewerCount`) and the frozen budgets (`COST_BUDGET`, `TIME_BUDGET`) so the scheduler grades on the same scale Darwin already optimizes against — a child that wastes budget is penalized by `fitness()` *and* terminated by the scheduler.

## Consequences

### What changes
- Every harness run gains a single, explicit, audited termination contract. `BenchmarkReceipt` carries a `TerminationReason`; no run can end silently.
- Retry, escalation, context-growth, and reviewer-pass limits move from scattered implicit checks into one reviewable `SchedulerPolicy`.
- Fail-closed becomes a first-class, non-mutatable behavior tied to `policy.detectUnsafe` and the `strict-defensive` profile, strengthening ADR-079's risk discipline.

### What does not change
- `scoring.ts` stays frozen: the scheduler enforces budgets, it does not grade. `COST_BUDGET`/`TIME_BUDGET` keep their meaning; the scheduler reuses them, it does not redefine them.
- `genome.ts BOUNDS` remain the source of truth for `retryBudget`/`reviewerCount`/`fuzzBudgetSeconds`; `SchedulerPolicy` mirrors and may only *tighten*, never widen, them.
- The `agentic.ts` `maxSteps` bound and read-only/oracle-only tool surface are preserved; the scheduler wraps them.
- The model stays frozen. The scheduler changes *when the harness stops*, not what the model is.

### What hurts
- A real risk of premature termination: a too-tight `costBudget` or `maxRetriesPerNode` can cut off a run that would have succeeded one step later. We accept this as the safe trade-off — and the budget-cap test pins it. Tuning the budgets is itself an evolvable surface (ADR-159), so Darwin can search for the lean optimum the way `scoring.ts` already incentivizes.
- Fail-closed will occasionally refuse a *benign* finding that trips `detectUnsafe`'s intentionally broad patterns. This is the correct default for a strict-defensive harness; the cost is recall, not safety.
- One more module on the run's hot path. Mitigated by keeping `schedule()` pure and deterministic (no I/O), so it adds bounded, reproducible overhead.

## Alternatives Considered

1. **Leave bounding to genome clamps + `agentic.ts maxSteps`.** Already partly works. Rejected: it gives no unified, typed termination contract, no fail-closed guarantee across `swarm.ts`/`evolve.ts`, and exits are silent — failing the acceptance test's "typed reason" and "no silent infinite retry" clauses.
2. **A global wall-clock timeout only.** Simple, but non-deterministic (wall-clock) so it breaks replay, and it gives one undifferentiated reason ("timed out") instead of a typed cause. Rejected: violates *the proof is in replay*.
3. **Best-effort recovery with unbounded retries until success.** Maximizes recall. Rejected outright: this is precisely the unbounded-recovery anti-pattern the borrowed research warns against — the fastest way to burn money and accumulate unbounded risk.
4. **Fail-open on security uncertainty (warn and continue).** Lower friction. Rejected on safety grounds: a strict-defensive harness must fail-closed; `failClosedOnSecurityUncertainty` is pinned to the literal `true` in the type so it cannot be mutated away.
5. **Mutate scheduling via prompt instructions to the agent.** Rejected on thesis grounds — *Darwin Mode mutates structured policies, not prompts*. Budgets are typed fields, enforced by code, not asked of a model.

## Test Contract

London-school unit tests (the scheduler's collaborators — the loop step function and `policy.detectUnsafe` — are stubbed; we verify the scheduler's control decisions, not the oracles) plus integration tests against the real `agentic.ts` loop. Proposed file `packages/darwin-mode/src/security/__tests__/scheduler.test.ts`.

- **`budget-cap never exceeds COST_BUDGET/TIME_BUDGET`** (integration): run `schedule()` over the `agentic.ts` loop on a corpus where the natural cost would exceed `COST_BUDGET=20`; assert `outcome.costSpent <= COST_BUDGET` and `outcome.timeSpent <= TIME_BUDGET` for every run, and that the exit reason is `BudgetExhausted` when (and only when) a budget is the binding constraint. Operationalizes *"no task can exceed budget."*
- **`typed-termination every exit carries a TerminationReason`** (unit): drive `schedule()` into each terminal condition (success, retry exhaustion, escalation cap, context overflow, reviewer cap, security uncertainty) and assert `outcome.reason` is the matching `TerminationReason` member and is never `undefined`. Operationalizes *"every failure exits with a typed reason."*
- **`no-infinite-loop a looping node is killed`** (unit): stub a node step that never reports progress (always requests another retry); assert `schedule()` halts at exactly `maxRetriesPerNode` retries with `TerminationReason.MaxRetries` and does not exceed it. Operationalizes *"no silent infinite retry loops."*
- **`fail-closed on security uncertainty`** (unit): stub `policy.detectUnsafe` to return a non-empty reason set on the next action; assert `schedule()` halts immediately with `TerminationReason.SecurityUncertain`, `failedClosed: true`, and spends no further budget. Also assert a finding with `exploitCodeAllowed !== false` triggers the same fail-closed exit.
- **`policy mirrors genome bounds, never widens`** (unit): for genomes across the `BOUNDS` envelope, assert `defaultSchedulerPolicy(g).maxRetriesPerNode === g.retryBudget` and `maxReviewerPasses <= 5`, and that a hand-constructed policy with `maxRetriesPerNode = 7` is rejected as out of bounds.
- **`determinism: same inputs, same outcome`** (integration): run `schedule()` twice with a fixed seed and fixed (recorded) model outputs; assert byte-identical `ScheduleOutcome` and identical `TerminationReason` — the scheduler honors *the proof is in replay*.

## Reference implementation

A dependency-free, deterministic reference lives in the `@metaharness/projects` package (committed this session; 117 passing tests across the package). Module: `packages/projects/src/scheduler.ts` (+ `__tests__/scheduler.test.ts`, `bench/scheduler.bench.mjs`). It implements `EscalationScheduler`, `SchedulerPolicy`, and a typed `TerminationReason` (including a distinct `max_reviewer_passes`). Every run terminates with a typed reason, budgets are never unboundedly exceeded, and it fails closed on security uncertainty. The bench writes a receipt to `packages/projects/bench/results/scheduler.json`; both arms are real scheduler runs (not a simulated baseline). Bounding cuts doomed-task cost (~88% on a seeded ~40%-doomed mix) — this figure is scenario-dependent, not universal.

## References

- Structured graph-harness scheduling research — explicit plans, separated planning/recovery layers, strict escalation protocols, bounded recovery loops. Pattern source; no product imported.
- ADR-153 (agentic-loop architecture) and `agentic.ts` — the bounded ReAct loop (`maxSteps`, restricted tool surface) the scheduler wraps.
- ADR-155 (Darwin Shield) — `HarnessGenome` clamps, `policy.ts` `detectUnsafe`, the safety gate, `BenchmarkReceipt`.
- ADR-079 (SGM statistical gates + risk budget) — the cumulative risk budget fail-closed termination spends against.
- ADR-072 (frozen scorer/promotion) and `scoring.ts` (`COST_BUDGET=20`, `TIME_BUDGET=5`) — the budgets the scheduler reuses, never redefines.
- ADR-082 (expected gains + effective-performance) — frames the 10–35% cost-reduction hypothesis the budget-cap test validates.
- ADR-159 (HarnessSpec) — `SpecStep.loop` / `SpecBudgets`, the declarative home for the policy fields.
- ADR-156 (borrowed-pattern integration program) — umbrella: *mutate structured policies, not prompts.*
