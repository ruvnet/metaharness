# ADR-164: Darwin Safety Rails — immutable, programmable guardrails

**Status**: Proposed — reference implementation in `@metaharness/projects`
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-RAILS`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: A registry of programmable, interpretable, immutable safety rails evaluated over a candidate harness/spec/diff *before* benchmark execution — the anti-reward-hacking spine that stops a mutation from "improving" by cheating.
**Related**: ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces + allowlist — `safetyProfile` immutable), ADR-072 (frozen scorer/promotion), ADR-073 (archive), ADR-079 (SGM statistical gates + risk budget), ADR-080 (non-self-editable policy/scorer), ADR-082 (expected gains — treat as hypotheses), ADR-153 (agentic-loop architecture), ADR-155 (Darwin Shield), ADR-156 (umbrella — "mutate structured policies, not prompts"), ADR-159 (HarnessSpec), ADR-163 (Typed Handoffs — the security edge is immutable for the same reason)

> We borrow the pattern from **NeMo Guardrails** — programmable, interpretable, runtime rails defined independently of the underlying LLM — and we copy the *pattern, not the product*: no Colang, no NeMo runtime, no rails expressed as model prompts. Where NeMo rails sit between a user and a model at conversation time, Darwin Rails sit between a *mutation* and the *benchmark*: a candidate genome/spec/diff is checked by deterministic predicates before it is ever allowed to run for score. The point is the same point that runs through all of Darwin Mode: **the foundation model stays frozen; the harness evolves; the proof is in replay**, and because **Darwin Mode mutates structured policies, not prompts**, the rails can be structured policies too — interpretable, replayable, and crucially *outside the mutation surface*. A mutation engine that could rewrite its own rails could "improve" by disabling the tests, weakening a check, or editing a protected file. The rails exist precisely so it cannot.

## Context

Darwin Shield already has a real, code-level safety spine:

- `policy.ts` `detectUnsafe(text)` / `gateOutputs` — rejects weaponized output; `unsafeOutputs` must be 0 for a run to pass acceptance (ADR-155).
- `scoring.ts` `fitness()` — `unsafeOutputs` is the single `-1.00` / hard-reject term in the otherwise-bounded fitness; it is the one term that can sink a genome regardless of how good its detection looks.
- `types.ts` — `safetyProfile: 'strict-defensive'` is pinned to a literal and **never mutated** (ADR-071); `Finding.exploitCodeAllowed` is the literal `false`.
- ADR-080 — the policy and scorer are **not self-editable**; a child cannot re-grade itself.

These guard the **output** of a run. They do not, by themselves, guard the **mutation** that produced the run. A sufficiently clever mutation could try to win the benchmark by *changing the rules of the benchmark*: disabling or skipping tests so the test-pass term inflates, weakening a security check so false positives drop, bypassing the sandbox, or editing a protected file (CI config, the scorer, the corpus, the rails themselves). This is textbook reward hacking: the genome optimizes the measured proxy instead of the real objective. The existing output gate would not necessarily catch a *test-disabling* mutation, because the resulting run can look clean.

NeMo Guardrails solves the analogous problem for conversational LLMs with **programmable rails** — explicit, interpretable rules enforced by a runtime that is independent of the model. We borrow that shape and move it earlier in the loop: a registry of rails evaluated **pre-benchmark** against the candidate itself. Rails are interpretable (each is a named predicate with a description and an explanation on failure), independent of the frozen model, and — the decisive property — **they are not in the mutation surface**. They cannot be evolved, tuned, or disabled by any operator, by construction.

**Expected impact (HYPOTHESIS, not a result):** lower governance risk and stronger enterprise trust, by giving auditors a small, readable, replayable set of invariants that no evolutionary pressure can erode. We make no quantitative claim; the value is categorical (a class of reward-hacking is made impossible) and is demonstrated by the rejection tests below, per ADR-082.

## Decision

Define a programmable `SafetyRail` and a `RailRegistry` evaluated **before** any candidate is benchmarked. A candidate that trips any rail is rejected pre-eval; it never enters the sandbox, never gets a `ScoreCard`, never enters the archive.

```ts
// PROPOSED module: packages/darwin-mode/src/security/rails.ts
import type { HarnessGenome } from './types.js';

/** Everything a rail may inspect about a candidate, pre-benchmark. */
export interface RailSubject {
  /** The candidate genome (carries the immutable safetyProfile). */
  genome: HarnessGenome;
  /** The candidate HarnessSpec (ADR-159), if the run evolves specs. */
  spec?: unknown;
  /** The proposed diff against the parent (unified-diff text), if any. */
  diff?: string;
  /** Files the diff touches (resolved, repo-relative paths). */
  touchedFiles: string[];
}

export interface RailVerdict {
  railId: string;
  /** True iff the candidate VIOLATES the rail (and must be rejected). */
  violated: boolean;
  /** Human-readable reasons (interpretable, for the audit receipt). */
  reasons: string[];
}

/**
 * One programmable rail. `predicate` is PURE deterministic code (no model, no
 * network) so the verdict is replayable. `immutable` is the literal `true` for
 * every rail in the registry — a rail can never be evolved or disabled.
 */
export interface SafetyRail {
  id: string;
  description: string;
  /** Returns true iff the subject VIOLATES this rail. */
  predicate: (subject: RailSubject) => boolean;
  /** Why it was violated (empty ⇒ clean), for the receipt. */
  explain: (subject: RailSubject) => string[];
  /** Structural pin: always true. Rails are outside the mutation surface. */
  immutable: true;
}
```

The registry is a frozen list, evaluated as an AND of "no rail violated":

```ts
export interface RailGateResult {
  /** True iff NO rail is violated and the candidate may be benchmarked. */
  admit: boolean;
  verdicts: RailVerdict[];
  /** All violation reasons, deduped, for the audit trail. */
  reasons: string[];
}

/** The immutable rail set. Cannot be re-assigned, extended, or pruned at runtime. */
export const RAILS: ReadonlyArray<SafetyRail>;

/**
 * Evaluate every rail against a candidate BEFORE benchmark execution. Any
 * violation ⇒ admit=false ⇒ the candidate is rejected pre-eval (no ScoreCard,
 * no archive entry). Deterministic; same subject ⇒ same result ⇒ same receipt.
 */
export function evaluateRails(subject: RailSubject): RailGateResult;
```

The initial immutable rail set encodes the "do not" list from the spec, building on the existing spine:

```ts
// Conceptual contents of RAILS (each `immutable: true`):
//
//  rail/secrets-handling-untouched   — diff must not weaken/remove secret-redaction
//                                       or .env handling; touchedFiles ∩ secretFiles = ∅.
//  rail/security-checks-not-weakened  — diff must not remove/relax a call into policy.ts
//                                       (detectUnsafe/gateOutputs) or lower a risk gate.
//  rail/tests-not-disabled            — diff must not delete, skip, xfail, or no-op the
//                                       benchmark/test suite (the acceptance-test rail).
//  rail/sandbox-not-bypassed          — diff must not introduce write/exec/shell/network/
//                                       fetch/delete (the agentic FORBIDDEN_TOOLS, agentic.ts).
//  rail/protected-files-need-approval — touchedFiles ∩ PROTECTED = ∅ without an approval
//                                       attestation; PROTECTED ⊇ { scorer, policy, rails,
//                                       corpus, CI config }.
//  rail/safety-profile-immutable      — genome.safetyProfile === 'strict-defensive', always.
//  rail/scorer-policy-not-self-edited — diff must not touch scoring.ts / policy.ts / rails.ts
//                                       (ADR-080: non-self-editable).
```

Three properties are load-bearing and distinguish this from a tunable check:

1. **Independent of the model.** Rails never call the frozen foundation model; they are deterministic predicates over structure (genome fields, diff text, touched paths). A model cannot argue its way past a rail.
2. **Pre-benchmark.** Rails run *before* the sandbox. A test-disabling mutation is rejected before it can ever produce a flattering score — closing the reward-hacking loop that an output-only gate leaves open.
3. **Outside the mutation surface.** `immutable: true` is structural. The mutation operators (ADR-071) have no `RailSubject`-shaped target; rails and `safetyProfile` are simply not in `MutationSurface`. This is the same reasoning that makes the `security` hand-off edge immutable in ADR-163.

Rails compose with, and do not replace, the existing controls: the `unsafeOutputs` `-1.00`/hard-reject term (`scoring.ts`), the `detectUnsafe`/`gateOutputs` output gate (`policy.ts`), and the immutable `safetyProfile` (`types.ts`). Rails add the *pre-eval, anti-cheat* layer those three did not cover.

## Consequences

**What changes.**
- The evolution loop (`evolve.ts` / `real-evolve.ts`) gains a pre-benchmark `evaluateRails` step. A candidate that trips any rail is rejected before scoring — it gets no `ScoreCard` and never enters the archive (ADR-073).
- Auditors get a small, interpretable, replayable invariant set: each rail has an `id`, a `description`, and an `explain` trail in the receipt.
- A new, categorical class of reward hacking (disable tests, weaken a check, edit protected files, bypass sandbox) is made *impossible by construction*, not merely penalized.

**What does not change.**
- The foundation model stays frozen; rails never invoke it. They are structured policies, not prompts.
- The frozen scorer (`scoring.ts`, ADR-072/155) is untouched: `unsafeOutputs` remains the only `-∞`/hard-reject fitness term. A rail violation is a *pre-eval rejection*, not a new fitness term — it never enters the scored manifold at all.
- The output gate (`policy.ts` `detectUnsafe`/`gateOutputs`) and the immutable `safetyProfile` are unchanged; rails sit *upstream* of them.
- Determinism and replay: rails are pure, so the admit/reject verdict is byte-stable for a given subject.

**What hurts.**
- Rails are deliberately conservative; they will sometimes reject a *benign* mutation that pattern-matches a forbidden shape (e.g. a refactor that legitimately moves a test file). The `rail/protected-files-need-approval` rail provides the escape hatch (an approval attestation), but it adds human-in-the-loop friction — that friction is the point for protected files.
- A rail predicate is only as good as its pattern. A too-narrow `rail/tests-not-disabled` could miss a novel way to neuter the suite. Mitigation: rails are interpretable and reviewed like any safety code, and they are versioned with the package (never at runtime, never by the mutator).
- Because rails cannot be evolved, improving them is a human-authored, ADR-tracked change — slower than letting the system "learn" them, but that slowness is the safety guarantee.

## Alternatives Considered

1. **Output gate only (status quo).** `policy.ts` + the `unsafeOutputs` term guard what leaves the sandbox but not the mutation that wrote the run. A test-disabling mutation can produce a clean-looking run. Rejected as insufficient.
2. **Penalize cheating via a fitness term.** Add a negative term for "looks like it disabled tests." This keeps the cheating candidate *in* the scored manifold and makes safety a tunable trade-off the optimizer can learn to skirt. Rejected: safety must be a gate, not a price.
3. **Adopt NeMo Guardrails / Colang directly.** Couples Darwin to an external runtime and to model-time, conversation-shaped rails — the wrong layer (output, not mutation) and the wrong representation (prompt-shaped). Rejected: copy the pattern, not the product.
4. **Let rails be a low-priority mutation surface "with guards."** Any path by which evolution can touch its own rails is a reward-hacking vector. Rejected outright; `immutable: true` is structural, and rails are absent from `MutationSurface` entirely (ADR-071/080).
5. **Model-judged rails (LLM decides if a mutation cheats).** Non-deterministic, breaks replay, and re-introduces the frozen model into the safety decision. Rejected; conflicts with the replay thesis.

## Test Contract

These named tests operationalize the ADR-155 acceptance test ("inject a mutation that disables tests; the system must reject it before benchmark execution").

- **`rails/inject-test-disabling-mutation-rejected`** — feed `evaluateRails` a `RailSubject` whose `diff` skips/`xfail`s/deletes the benchmark suite; assert `admit=false`, the `rail/tests-not-disabled` verdict is `violated`, and the candidate is rejected **before** the sandbox runs (no `ScoreCard` produced).
- **`rails/protected-file-edit-rejected`** — a candidate whose `touchedFiles` intersects `PROTECTED` (scorer, policy, rails, corpus, CI config) with no approval attestation yields `admit=false` via `rail/protected-files-need-approval`; with a valid attestation it is admitted.
- **`rails/security-check-weakening-rejected`** — a diff that removes or relaxes a call into `policy.ts` (`detectUnsafe`/`gateOutputs`) or lowers a risk gate is rejected by `rail/security-checks-not-weakened`.
- **`rails/sandbox-bypass-rejected`** — a diff introducing any `FORBIDDEN_TOOLS` capability (`write`/`exec`/`shell`/`network`/`fetch`/`delete`, per `agentic.ts`) is rejected by `rail/sandbox-not-bypassed`.
- **`rails/secrets-handling-untouched`** — a diff touching `.env`/secret-redaction paths is rejected by `rail/secrets-handling-untouched`.
- **`rails/rails-not-in-mutation-surface`** — the invariant test: assert no mutation operator (`mutate`, `crossover`, ADR-071) can produce a candidate that alters a `SafetyRail` or `genome.safetyProfile`; every `SafetyRail.immutable === true`; `RAILS` is not re-assignable; and the union `MutationSurface` contains no rail/safety target.
- **`rails/safety-profile-immutable`** — across an exhaustive operator pass, every produced genome has `safetyProfile === 'strict-defensive'` (re-asserts ADR-071 at the rail layer).
- **`rails/scorer-policy-not-self-edited`** — a diff touching `scoring.ts` / `policy.ts` / `rails.ts` is rejected by `rail/scorer-policy-not-self-edited` (ADR-080).
- **`rails/replay-determinism`** — same `RailSubject` evaluated twice yields byte-identical `RailGateResult` (pure predicates).
- **`rails/clean-candidate-admitted`** — a normal bounded mutation (within `reviewerCount` 1..5, `retryBudget` 1..6, etc.) touching only approved mutation-surface files yields `admit=true` with no verdicts — rails do not block legitimate evolution.

## Reference implementation

A dependency-free, deterministic reference of this ADR lives in `@metaharness/projects` (committed this session): `packages/projects/src/safety-rails.ts` (with its test and `bench/safety-rails.bench.mjs`). It implements immutable (`Object.freeze`d) `SafetyRail`s plus a `RailRegistry`; `rejectsBeforeBenchmark` always enforces the builtin rail battery even when a caller passes a stripped registry, and protected-path matching is normalized and word-anchored (it catches `scoring-helpers.ts` but not `policyholder.ts`). The package as a whole has 117 passing tests. The synthetic bench is a deterministic simulation; its receipt (`packages/projects/bench/results/safety-rails.json`) shows 100% of cheating mutations rejected with 0 false rejections.

## References

- NeMo Guardrails — programmable, interpretable, model-independent runtime rails (pattern borrowed; runtime/Colang not adopted). https://github.com/NVIDIA/NeMo-Guardrails
- ADR-155 (Darwin Shield) — safety controls, `unsafeOutputs` acceptance counter, `Finding.exploitCodeAllowed=false`.
- ADR-080 (non-self-editable policy/scorer) — the rails are the structural enforcement of this.
- ADR-071 (mutation surfaces + allowlist) — `safetyProfile` immutable; rails are absent from `MutationSurface`.
- ADR-072 (frozen scorer/promotion) — `unsafeOutputs` is the only `-∞`/hard-reject fitness term; rails add a pre-eval gate, not a new term.
- ADR-079 (SGM statistical gates + risk budget) — rails complement the cumulative risk cap on promotions.
- ADR-156 (umbrella) — "mutate structured policies, not prompts"; rails are structured policies that are *not* mutated.
- ADR-159 (HarnessSpec) and ADR-163 (Typed Handoffs) — the security hand-off edge is immutable for the same anti-cheat reason.
- ADR-082 (expected gains) — governance/trust impact stated as a hypothesis, not a measured result.
- Real grounding: `packages/darwin-mode/src/security/policy.ts`, `scoring.ts`, `types.ts`, `genome.ts`, `agentic.ts`.
