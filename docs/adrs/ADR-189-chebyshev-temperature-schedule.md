# ADR-189 — Chebyshev-Scheduled Temperature Curves for ReAct Trajectory Stabilization

**Status:** Proposed (n=25 A/B in-flight)
**Date:** 2026-06-24
**Related:** ADR-185 (SOTA-breaking levers, Lever #2), ADR-188 (Chebyshev functional-schedule genome, PR #49), LEARNINGS §32-33

---

## Context

The agentic loop (`solve-agentic` / FUGU `xcascade`) currently sends a **single static temperature** to every LLM call across the whole ReAct trajectory (default `temperature=0`). Software engineering is not a uniform process, so a static value is a structural compromise:

1. Early steps (read the issue, `grep`, `ls`, map the candidate space) benefit from **higher temperature** — broad exploration, diverse search strategies.
2. Late steps (the final `edit`/`line_edit`/`submit`) need **greedy precision** — high temperature there produces *end-of-trajectory syntax hallucinations*: plausible but malformed patches that fail at the finish line.

The `crates/poker-darwin` arc (PR #49 / ADR-188) demonstrated that **non-stationary Chebyshev schedules** beat every static configuration on an exact-exploitability oracle. We port that "schedule the hyperparameter over depth" idea to the SWE-bench reasoning loop, starting with temperature.

Per the one-clean-lever discipline, this is **isolated from the entropy-guided escalation gate** (ADR-185 Lever #2) so any n=25 delta is unambiguously attributable to generation stability.

---

## Decision

Add a **step-depth temperature schedule** that runs hot early and anneals to greedy `0` at the edit/submit steps. Flag-gated (`--cheb-temp`), additive, off by default.

### Implemented schedule (what actually ships)

In `agentic-loop.mjs`, exported `chebTemp(step, maxSteps, tHi=0.8, tLo=0, gamma=2)`:

```
x = (step - 1) / (maxSteps - 1)            // normalized loop depth ∈ [0,1]
w = ((1 + cos(π·x)) / 2) ^ gamma           // raised half-cosine taper
T(step) = tLo + (tHi - tLo) · w
```

This is a **Chebyshev-node-spaced cosine taper** (Chebyshev nodes *are* cosine-spaced, clustering at the interval extremes) — high and flat early, sharp collapse late. `gamma=2` lengthens the hot burst and steepens the late collapse. It is O(1) per step with zero heap allocation. Measured shape at `maxSteps=18, tHi=0.8`: step 1 → 0.80, step 6 → 0.51, step 9 → 0.24, step 12 → 0.06, step 18 → 0.00.

> **Phase-2 generalization (queued):** replace the fixed raised-cosine with a full Clenshaw-evaluated Chebyshev polynomial whose coefficient array is *evolved* by Darwin (as in ADR-188), so the curve's shape is tuned to measured resolve rather than hand-set. The current direct form is the clean single-variable starting point.

### Experimental setup (n=25 A/B — isolated)

Same 25 SWE-bench-Lite instances, model `z-ai/glm-5.2`, `--max-steps 18`, conformant (`--no-test-oracle`), official Docker gold eval. Two arms differing **only** in temperature policy:

- **Control — `cheb-glm-static-25`:** static greedy (`temperature=0` throughout — our current default).
- **Treatment — `cheb-glm-cheb-25`:** `--cheb-temp --cheb-hi 0.8` (hot 0.8 → greedy 0 over step depth).

The decisive metric is **Δresolve = treatment − control** on the identical instance set, plus a syntax/empty-patch-rate check. (A static-`0.7` control is a possible follow-up arm; the static-`0` control isolates "does early exploration heat help" most cleanly against today's default.)

---

## Status / metrics

| Phase | Task | Effort | Status |
|---|---|---|---|
| 1 | n=25 A/B (static-greedy vs hot→greedy) | S | **In-flight** (local, ~$1, GLM) |
| 2 | Darwin-evolved Clenshaw coefficient lock | S | Queued (pending Phase-1 signal) |
| 3 | Compose with entropy escalation gate (ADR-185 #2) | M | Queued |

Decision rule: if Δresolve ≥ +1 instance and syntax-failure rate drops, promote to an n=300 confirm and into the FUGU default; if flat, record the null cleanly (lever ruled out for ~$1) and pivot effort to AST-mincut localization (ADR-190). **No promotion without the n=300 confirm** — n=25 is directional only.

---

## Consequences

- **Targets end-of-trajectory syntax hallucination** directly: greedy decoding at the `<patch>` step removes high-temp sampling noise exactly where it is most destructive.
- **No confound:** standalone temperature arm → any resolve delta is attributable before the entropy gate is layered on.
- **Zero runtime overhead:** O(1)/step, zero-alloc; no change to cost except whatever resolve/empty-patch movement the schedule produces.
- Projected impact (to be validated, not claimed): +2–5 pts absolute on cheap-tier resolve by rescuing finish-line failures; it does **not** synthesize intelligence the model lacks — localization (ADR-190) remains the larger floor-lifting lever.
