# ADR-163: Typed Handoffs — contracted agent-to-agent transitions

**Status**: Proposed — reference implementation in `@metaharness/projects`
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-HANDOFF`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: Make every agent-to-agent transition in the Darwin Shield swarm a schema-validated, budgeted, risk-gated contract — and make those contracts part of the evolvable harness spec, except the security gate.
**Related**: ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces + allowlist — `safetyProfile` immutable), ADR-072 (frozen scorer/promotion), ADR-073 (archive), ADR-079 (SGM statistical gates + risk budget), ADR-080 (non-self-editable policy/scorer), ADR-082 (expected gains — treat as hypotheses), ADR-153 (agentic-loop architecture), ADR-155 (Darwin Shield), ADR-156 (umbrella — "mutate structured policies, not prompts"), ADR-159 (HarnessSpec — the mutatable spec surface)

> We borrow the **handoff pattern from the OpenAI Agents SDK** — orchestration with explicit handoffs, guardrails, and human-approval paths — and we copy the *pattern, not the product*: no OpenAI runtime, no Agents-SDK dependency, no prompt-as-policy. Where the Agents SDK passes a free-form conversation between sub-agents and validates it with model-side guardrails, we make each transition a *typed contract* — input schema, output schema, risk level, allowed tools, budget, escalation threshold — validated by deterministic code before and after execution. This is the same thesis the rest of Darwin Mode runs on: **the foundation model stays frozen; the harness evolves; the proof is in replay**, and **Darwin Mode mutates structured policies, not prompts.** A handoff contract is a structured policy; it is exactly the kind of thing Darwin is allowed to evolve.

## Context

The Darwin Shield swarm (`packages/darwin-mode/src/security/swarm.ts`, ADR-155 §swarm execution) is today a hard-coded pipeline:

```
profile → rank → context → hypotheses → static + fuzz → review →
SAFETY GATE → patch → score → archive
```

The agent topology behind it — repo-profiler, file/risk-ranker, context-builder, hypothesis-generator, static-analysis-runner, fuzz-runner, patch-writer, reviewer (adversarial), safety-redactor, disclosure-writer, archive-curator — passes data agent-to-agent implicitly. Each agent reads whatever the previous one happened to leave in scope. There is no contract on what a "good" hand-off looks like, so:

- A vague or over-stuffed context bundle reaches `hypothesis-generator`, which then over-explores and burns the retry budget — visible today only as a worse `costUnits` / `timeToFinding` after the fact.
- A reviewer receives a finding with missing `evidence` and has to re-derive it, a wasted round-trip the scorer cannot localize to a specific edge.
- Token bloat compounds: each implicit hand-off tends to forward *everything*, because nothing says what the next stage actually needs.

The OpenAI Agents SDK answers the analogous problem with first-class **handoffs** plus **guardrails** and **human-in-the-loop approval** paths. The mechanism is sound; the implementation (model-side, prompt-shaped) is not what Darwin evolves. We want the same auditability and ambiguity-reduction expressed as *data*, so that (a) a bad hand-off is rejected by code, not by a model's judgment, and (b) the hand-off contracts themselves become a mutation surface — Darwin can evolve *how stages talk*, not just the knobs inside a stage.

Crucially, Darwin Shield is **strictly defensive**. The OpenAI SDK's canonical chain ends in a "release" action; ours does **not** end in a weaponizing release of exploits. Our defensive chain ends at `safety-redactor` → `disclosure-writer`: a redacted, gated advisory + patch + regression test, never a runnable exploit (`Finding.exploitCodeAllowed=false`, ADR-155). The "Security" stage's risk gate is the same boundary as `policy.ts` `gateOutputs` and is **not** evolvable.

**Expected impact (HYPOTHESIS, not a result):** 5–20% fewer retries and lower token bloat versus free-form hand-offs, plus per-edge auditability. We treat the percentage as a hypothesis to be falsified by the A/B test in the Test Contract, exactly as ADR-082 requires.

## Decision

Introduce a `HandoffContract` as a structured, validated description of one swarm edge. Contracts are declared as data, validated by code, and (except the security gate) are part of the mutatable `HarnessSpec` (ADR-159).

```ts
// PROPOSED module: packages/darwin-mode/src/security/handoff.ts
import type { SecurityTool } from './types.js';

/** The defensive role chain. NOTE: terminates at disclosure, not weaponization. */
export type SwarmRole =
  | 'planner'            // repo-profiler + file/risk-ranker + hypothesis ordering
  | 'coder'              // patch-writer (defensive patch + regression test)
  | 'tester'            // static-analysis-runner + fuzz-runner (validation)
  | 'reviewer'           // adversarial reviewer (falsification)
  | 'security'           // safety-redactor — the immutable gate (policy.ts)
  | 'disclosure';        // disclosure-writer — redacted advisory, NOT a release

/** Coarse risk class of a transition; drives the escalation path. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * A JSON-Schema-ish predicate handle. We do NOT take a schema *library* as a
 * dependency at the contract boundary; `validate` is deterministic code so a
 * hand-off verdict is replayable (same payload ⇒ same verdict ⇒ same receipt).
 */
export interface PayloadSchema<T = unknown> {
  /** Stable id for the receipt/audit trail. */
  id: string;
  /** Pure predicate: true iff the payload satisfies the schema. */
  validate: (payload: unknown) => payload is T;
  /** Human-readable reasons the payload failed (empty ⇒ valid). */
  explain: (payload: unknown) => string[];
}

/** One contracted edge of the swarm graph. */
export interface HandoffContract<I = unknown, O = unknown> {
  /** Stable contract id, e.g. "planner->coder". */
  id: string;
  from: SwarmRole;
  to: SwarmRole;
  /** The producer must satisfy `outputSchema`; the consumer requires `inputSchema`. */
  inputSchema: PayloadSchema<I>;
  outputSchema: PayloadSchema<O>;
  riskLevel: RiskLevel;
  /** The ONLY tools the `to` role may use while servicing this hand-off. */
  allowedTools: SecurityTool[];
  /** Bounded resource envelope for the consuming stage. */
  budget: {
    /** Max retries the consumer may spend (maps to genome.retryBudget, 1..6). */
    maxRetries: number;
    /** Deterministic cost-proxy ceiling (same units as swarm.ts costOf). */
    maxCostUnits: number;
    /** Time-to-finding proxy ceiling (same units as swarm.ts timeToFindingOf). */
    maxTimeUnits: number;
  };
  /** If post-hoc risk meets/exceeds this, escalate (e.g. to human approval). */
  escalationThreshold: RiskLevel;
  /**
   * Immutable contracts cannot be altered by any mutation operator. The
   * security gate edge sets this true; everything else defaults false and is
   * part of the HarnessSpec mutation surface (ADR-159).
   */
  immutable: boolean;
}
```

The verdict of running one contracted edge is itself a typed, replayable record:

```ts
export interface HandoffVerdict {
  contractId: string;
  /** Did the producer's payload satisfy outputSchema? */
  outputValid: boolean;
  /** Did the consumer's input satisfy inputSchema? */
  inputValid: boolean;
  /** Reasons (deduped) if either side failed. */
  reasons: string[];
  /** True iff the edge was executed (both schemas valid AND within budget). */
  executed: boolean;
  /** Set when post-hoc risk ≥ escalationThreshold. */
  escalated: boolean;
}

/**
 * Gate one hand-off. A hand-off whose producer output OR consumer input is
 * schema-invalid is REJECTED before the consumer runs. This is the
 * defensive analog of guardrails: code, not a model, decides admissibility.
 */
export function gateHandoff(
  contract: HandoffContract,
  producerOutput: unknown,
  consumerInput: unknown,
): HandoffVerdict;
```

The defensive chain wired onto the **real** swarm topology (`swarm.ts`):

```
planner   --[planner->coder]-->   coder
coder     --[coder->tester]-->    tester
tester    --[tester->reviewer]--> reviewer
reviewer  --[reviewer->security]->security      (risk gate; IMMUTABLE)
security  --[security->disclosure]->disclosure  (redacted advisory; NOT a release)
```

The `reviewer->security` and `security->disclosure` edges are `immutable: true` and bind `allowedTools` to nothing that can emit unredacted content. The `security` role *is* `policy.ts` `gateOutputs` / `redactUnsafeOutput`; the contract layer wraps it but cannot weaken it (ADR-080: policy/scorer are not self-editable).

A `HandoffGraph` (the ordered list of contracts) becomes a field of the `HarnessSpec` (ADR-159). Mutation operators (ADR-071) may add/remove tools from a non-immutable contract's `allowedTools`, tighten/loosen a budget within the existing genome bounds (`retryBudget` 1..6, etc.), or reorder non-security edges — but they may never touch an `immutable` contract, never raise `allowedTools` beyond the genome's `tools[]` allowlist, and never lower a risk gate. `safetyProfile` remains `'strict-defensive'` and is never mutated (ADR-071).

## Consequences

**What changes.**
- Every swarm edge gains an explicit, replayable verdict. A bad hand-off (missing `evidence`, malformed context bundle, over-budget request) is rejected *before* the consumer runs, which is what should drive the retry reduction.
- Hand-off contracts join the mutatable `HarnessSpec` (ADR-159): Darwin can now evolve *the wiring*, not just intra-stage knobs — a strictly larger, still-bounded search space.
- Receipts (`BenchmarkReceipt`, ADR-155) gain a per-edge audit trail, improving the auditability the OpenAI SDK gets from explicit handoffs.

**What does not change.**
- The foundation model stays frozen. Contracts are data + deterministic predicates; no prompt is the policy.
- The frozen scorer (`scoring.ts` `fitness()` / `findingScore()`, ADR-072/155) is untouched. `unsafeOutputs` remains the only `-∞`/hard-reject term; a rejected hand-off is a *retry/cost* signal, not a new fitness term.
- The security gate (`policy.ts`) is unchanged behavior; the contract layer only wraps it. `Finding.exploitCodeAllowed=false` still holds; the chain still ends at disclosure, never at a weaponizing release.
- Determinism: same `(spec, corpus, seed)` ⇒ byte-identical receipts, because `validate`/`explain` are pure.

**What hurts.**
- Authoring cost: every edge now needs an explicit input/output schema. Under-specified schemas silently re-admit ambiguity; over-specified schemas reject valid payloads and *increase* retries — the A/B test must guard against a self-inflicted regression.
- Larger mutation surface ⇒ more ways to waste a generation on a wiring change that does nothing. Mitigated by the SGM risk budget and statistical promotion gate (ADR-079) — a wiring mutation must still beat its parent to promote.
- A mis-set non-immutable `escalationThreshold` could over-escalate (noise) or under-escalate (missed review). The security edge is immutable specifically so this knob can never weaken the safety boundary.

## Alternatives Considered

1. **Free-form hand-offs (status quo).** Simplest, but no per-edge auditability and no way to localize retry waste. This is the A/B *control*, not the decision.
2. **Adopt the OpenAI Agents SDK directly.** Couples Darwin to an external runtime and to prompt-shaped, model-side guardrails — the opposite of "mutate structured policies, not prompts." Rejected: we copy the pattern, not the product.
3. **Model-side guardrails (LLM judges the hand-off).** Non-deterministic, breaks replay, and makes admissibility a function of the frozen model rather than the harness. Rejected; conflicts with the replay thesis.
4. **One monolithic schema for the whole pipeline.** Loses the per-edge gradient (you cannot tell *which* hand-off was bad) and cannot be partially mutated. Rejected.
5. **Make even the security edge mutatable, with a guard.** Any path to weakening the gate via evolution is a reward-hacking vector (see ADR-164). Rejected outright; the security edge is `immutable: true` (ADR-080).

## Test Contract

These named tests operationalize the ADR-155 acceptance test ("reject any handoff without schema-valid input AND output; measure retry reduction").

- **`handoff/rejects-schema-invalid-input`** — given a contract and a `consumerInput` that fails `inputSchema.validate`, `gateHandoff` returns `executed=false`, `inputValid=false`, and the consumer stage is never invoked.
- **`handoff/rejects-schema-invalid-output`** — given a `producerOutput` that fails `outputSchema.validate`, `gateHandoff` returns `executed=false`, `outputValid=false`; the downstream consumer is never reached.
- **`handoff/admits-valid-both`** — a payload satisfying both schemas and within `budget` yields `executed=true`, no `reasons`.
- **`handoff/budget-overrun-rejected`** — a request exceeding `maxRetries`/`maxCostUnits`/`maxTimeUnits` is rejected before execution (bounded-resource invariant).
- **`handoff/allowed-tools-subset-of-genome`** — for every contract, `allowedTools ⊆ genome.tools` (the ADR-071 allowlist); a contract requesting an off-allowlist tool fails validation.
- **`handoff/security-edge-immutable`** — the `reviewer->security` and `security->disclosure` contracts have `immutable=true`; applying any mutation operator to them is a no-op (and asserts), per ADR-080.
- **`handoff/ab-retry-reduction`** — run the identical task suite twice on the same frozen model: once with free-form hand-offs (control), once with typed contracts (treatment). Assert mean retries(treatment) ≤ mean retries(control). The 5–20% figure is logged as a HYPOTHESIS; the test only asserts non-regression in retries AND no regression in `truePositiveRate`/`unsafeOutputs` (which must stay 0).
- **`handoff/replay-determinism`** — same `(spec, corpus, seed)` produces byte-identical per-edge verdicts across two runs.
- **`handoff/disclosure-not-release`** — the terminal edge emits only gated, redacted output (`gateOutputs` applied); assert no `Finding` with `exploitCodeAllowed !== false` can traverse it.

## Reference implementation

A dependency-free, deterministic reference of this ADR lives in `@metaharness/projects` (committed this session): `packages/projects/src/handoffs.ts` (with its test). It implements `HandoffContract`, `validateHandoff`, `HandoffChain`, and `defaultChain` (defensive, terminating at disclosure). The package as a whole is deterministic with 117 passing tests. A REAL-LLM validation (`bench/handoff-llm.bench.mjs`, receipt `packages/projects/bench/results/handoff-llm.json`, openai/gpt-4o-mini via OpenRouter) found that naming the contract's required fields up front made 18/18 hops valid first-try (0 retries) versus free-form 0/18 (18 retries) — a 100% retry reduction on this run. Caveat: this is a single non-deterministic run; the effect size depends on how far the required field names diverge from the model's defaults. Real-LLM benches are optional, API-key-gated (OpenRouter), and excluded from the deterministic test suite.

## References

- OpenAI Agents SDK — handoffs, guardrails, and human-in-the-loop approval patterns (pattern borrowed; product not adopted). https://openai.github.io/openai-agents-python/
- ADR-155 (Darwin Shield) — swarm topology, safety gate, acceptance criteria, `Finding.exploitCodeAllowed=false`.
- ADR-153 (agentic-loop architecture) — "Darwin's mutation surfaces become the policy the loop evolves."
- ADR-156 (umbrella) — "mutate structured policies, not prompts."
- ADR-159 (HarnessSpec) — the mutatable spec surface a `HandoffGraph` joins.
- ADR-071 (mutation surfaces + allowlist) — bounded operators; `safetyProfile` immutable.
- ADR-072 (frozen scorer/promotion) and ADR-080 (non-self-editable policy/scorer).
- ADR-079 (SGM statistical gates + risk budget) — promotion of a wiring mutation must clear the same gate.
- ADR-082 (expected gains) — expected-impact percentages are hypotheses.
- Real grounding: `packages/darwin-mode/src/security/swarm.ts`, `policy.ts`, `types.ts`.
