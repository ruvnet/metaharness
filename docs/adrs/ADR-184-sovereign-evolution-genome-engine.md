# ADR-184 — Sovereign Evolution: evolve the solver architecture (genome engine)

**Status**: Engine implemented + validated on mock fitness (`evolve-arch.mjs`); real-data (Firestore) fitness wired + tested; live prove-dispatch loop in gcp-cluster evolve
**Date:** 2026-06-23
**Related:** ADR-179 (Value Score), ADR-181 (prove substrate), ADR-087/096 (statistical-gate promotion), §18-20

## Context

We mapped the SWE-solver architecture space BY HAND (single → Best-of-N → discriminator → cascade → repro-gate).
Darwin's thesis is "freeze the model, evolve the harness" — so the search itself should be evolutionary. The
substrate exists (`prove`/`rank`/SAMPLE, ADR-181). The risk: n=25 fitness is volatile (measured 52%→39.7%
drift, §18) → blind small-sample selection over-fits to noise.

## Decision

`evolve-arch.mjs` evolves a **config genome** `{model, mode(single|bo3|cascade), escalate, judge, maxSteps}`
toward the **Value Score** (ADR-179: `w·resolve% + (1-w)·cheapness`), with a **2-phase gate**:
1. **Phase 1 (filter):** evaluate the population on a fast small `prove` slice (high noise ≈ n=25); keep the elite.
2. **Phase 2 (promote):** re-evaluate finalists K× on a larger slice (low noise ≈ n=100); rank by confirmed
   mean ± 95% CI. Only a genome whose Value survives the gate is promoted/scaled — the over-fitting guard.

Pluggable fitness: `--fitness mock` (seeded, grounded in measured anchors §13/18/20 — for testing the engine)
vs `--fitness prove` (production — emits each genome as a `gcp-cluster prove` config, scored by a real GCP run).

## Validation (mock)

The engine converges, gives phase-2 CIs, and **traces the real frontier**: w≤0.5 → cheap single-traj;
w≥0.7 → Best-of-3 — matching our hand-measured champions, and surfacing that **the cost-Pareto optimum is
w-dependent** (there is no single "best" — it's a frontier). Testing also caught a real scale bug (resolve
fraction vs 0-100 cheapness) — fixed. This proves the search mechanics before spending GCP compute.

## Consequences

- A turn-key, over-fitting-safe architecture search: generate → small-`prove` filter → larger-`prove` gate → scale winner.
- Next: run `--fitness prove` once the fleet's multi-model rows seed the population from real data (not priors).
- The genome surface is extensible (temperatures, N, env-filter toggle, model-mix) as new levers are measured.

## Completion (2026-06-23): real-data fitness + LLM-mutation + autonomous autotune

- **Real fitness wired** (`--fitness firestore`): reads measured resolve from `darwin_runs`; `normMode` maps
  stored modes (`single-traj`/`best-of-3+judge`) → genome vocab (the fix that made real 34%/39.7% register);
  unmeasured genomes emit as a prove queue.
- **LLM-as-mutation-operator** (`llmPropose`): the LLM reads the measured frontier + Value formula and proposes
  INFORMED genomes (e.g. wrap a cheap model in bo3 to capture union while keeping a cheap judge) — complements
  blind GA mutation. `parseGenomes` validates/filters (tested). **NEVER used for promotion** — the statistical
  2-phase gate decides; the LLM only proposes + (optionally) sanity-checks. This is the firewall against meta-Goodhart.
- **Autonomous multi-generation loop** (`gcp-cluster autotune [gens] [w]`): each gen evolves on real Firestore
  data (GA + LLM proposals) → dispatches unmeasured as prove-25 GCP jobs → polls self-reports → re-evolves.
- **Runaway guards** (mandatory for an autonomous VM-spawner): gen cap, total-VM cap (≤20), per-gen cap (≤8),
  OpenRouter spend cap ($200), wall-clock cap (6h), and `finally { cleanupDone() }` so VMs never leak. 13 unit tests.
