# ADR-183 — Judge-validated self-written repro test as a resolution gate (Goodhart counter-measure)

**Status**: Pilot running (`repro-gate-pilot.mjs`); decision pending
**Date:** 2026-06-23
**Related:** §10 (MCTS Goodhart), §19 (cascade refuted — repo tests = regression guard, not resolution),
ADR-182 (cascade), §18 (Best-of-3 = 39.7% @ $0.015 — the bar)

## Context

§19 proved the repo's own tests are a *regression guard*, not a *resolution proxy* (fire 3.7% vs 34% gold —
the bug's test doesn't exist in the repo yet). A true conformant resolution gate would unlock cheap early-exit/
cascade. The candidate: the agent's **self-written `reproduce_bug.py`** (test-critic, validated fail-on-base).
But that re-opens the **Goodhart trap** (§10): the writer will write a test its own flawed patch passes.

## Decision (counter-measure: separate writer from evaluator)

Pilot a gate = **reproValid ∧ judgeOK ∧ passOnFix**:
- **reproValid** — repro FAILS on base (test-critic; reproduces the bug).
- **judgeOK** — a SEPARATE LLM judge reads the issue + the repro and confirms it genuinely tests the bug
  (not trivial/tautological/disconnected). Writer ≠ evaluator — the Goodhart defense.
- **passOnFix** — the repro PASSES once the candidate patch is applied.

**Validation bar (honest):** measure the gate's **precision against gold** on 25 (reusing existing patches +
setA gold — no re-solve). Two tests: (a) does gate-positive predict gold-resolved? (b) does judgeOK improve
precision over the no-judge gate? If judge-approval doesn't separate gold-pass from gold-fail, the gate is a
hallucination filtering a hallucination → kill it (like the cascade, §19). And any resulting system must beat
39.7% @ $0.015 or be meaningfully cheaper at ≥39.7%.

## Consequences

- If precision is high → a conformant resolution gate → cheap early-exit/cascade becomes viable (revisit ADR-182).
- If low → repro-gating stays Goodhart-trapped; parallel Best-of-3 + LLM-judge (§18) remains the champion.
- Either way it's a ~$1 measured answer, not a full-300 gamble.
