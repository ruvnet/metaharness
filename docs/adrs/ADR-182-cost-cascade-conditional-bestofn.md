# ADR-182 — Cost cascade (conditional Best-of-N) via the repo-test gate

**Status:** Implemented (`solve-agentic.mjs --cascade <model2>`); first run pending
**Date:** 2026-06-23
**Related:** ADR-178 (discriminator), §18 (Best-of-3 = 39.7% / 45% union)

## Context

Parallel Best-of-N pays for all N trajectories on every instance regardless of difficulty (39.7% @ $0.015,
§18). The union ceiling is 45% — there's headroom, but always-N is wasteful: ~a third of instances the cheap
tier already solves. A **cost cascade** (cheap-first → escalate only failures) is *conditional* Best-of-N:
spend the expensive tier's tokens only where needed.

## Decision

`--cascade <model2>` runs a 2-tier cascade gated by the **conformant repo-test signal** (`resolvedInLoop`):
1. **Tier 1** (cheap, e.g. DeepSeek-V4-Flash) solves in a fresh tree.
2. **Gate** = does the patch pass the changed module's *own existing tests* (Docker, never gold)? If yes → accept, stop (~$0.005).
3. **Escalate** only failures → **Tier 2 (e.g. GLM-5.2) COLD** (fresh container at base_commit — no Tier-1 transcript).
4. Tier 2 passes the gate → submit; **both fail → LLM-judge** picks the likelier patch (one may still pass hidden gold).

**Cold tier-2 (not warm):** the 45% union came from *independent* trajectories; warm-starting Tier 2 with
Tier 1's failed reasoning risks correlated failure (anchoring), shrinking the union. Warm-start is a separate
ablation, not v1.

Report adds `byTier {T1,T2,judge}`, `escalated`, and `blendedCostPerInst_usd`.

## Consequences

- Expected: resolve between single-traj (34%) and the union (45%) at a **blended cost far below always-Best-of-3**
  — a strictly better resolve-per-dollar point (the cost-Pareto lever from §18).
- The real escalation rate = the **repo-test gate-pass rate**, which differs from the gold rate; the run measures it.
- Cheap escalation target (GLM-5.2 / DeepSeek-V3.2) keeps the blend low; escalating to Opus would erase the cost edge.
- Self-hosting a small tier-1 rejected: small models scored 0–4% in our scaffold (§11) and GPU VM-hours aren't free.
