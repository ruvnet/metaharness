# ADR-243: SOTA coordination strategies as flywheel-evolvable radio levers

**Status**: Accepted (levers + priced sim + flywheel shipped, $0; live pod wiring deferred)
**Date**: 2026-08-08
**Project**: `ruvnet/metaharness`
**Related**: ADR-234/235 (flywheel macro-loop + re-executing verifiers + signed honest-null replay), ADR-236 (bounded-claims discipline), ADR-240 (AGNTCY network layer), ADR-241 (radio — passive-awareness swarm bus; this ADR extends its lever set)
**Source**: multiple fact-checked SOTA preprints (see `docs/research/RESEARCH-multi-agent-coordination.md`): PACT [arXiv:2606.05304](https://arxiv.org/abs/2606.05304), blackboard [arXiv:2510.01285](https://arxiv.org/abs/2510.01285) / [arXiv:2507.01701](https://arxiv.org/abs/2507.01701), TodyComm [arXiv:2602.03688](https://arxiv.org/abs/2602.03688), CONCAT [arXiv:2605.29612](https://arxiv.org/abs/2605.29612), staleness [arXiv:2502.14321](https://arxiv.org/abs/2502.14321), AgentRadio [arXiv:2607.28430](https://arxiv.org/abs/2607.28430)

> ADR-241 shipped radio's comms policy `{mode, foldEvery, postPolicy, digest}`
> as genome. The fact-checked SOTA is blunt about why that was the right shape:
> **PACT (F3) finds NO single coordination strategy is universally optimal — the
> winner is topology-dependent** — and **TodyComm (F5) finds the optimum MOVES
> under shifting/adversarial peers**. So the correct engineering response is not
> to read a paper and hand-pick a winner; it is to make each SOTA strategy a
> **lever** and let the frozen-gate flywheel **DISCOVER** the best combination
> per task. Freeze the model, evolve the coordination.

## Context

Two more SOTA coordination findings arrive as candidate strategies, and one
arrives as a cost the others must be priced against:

- **F6 [HIGH] — blackboard beats message-passing AND master-slave.** Shared,
  structured, validated state scores **37.53% vs 32.16%** on KramaBench and is
  more token-efficient than free-form dialogue
  ([arXiv:2510.01285](https://arxiv.org/abs/2510.01285) /
  [arXiv:2507.01701](https://arxiv.org/abs/2507.01701)). A candidate *topology*.
- **F9 [HIGH] — state staleness is async coordination's signature failure.**
  Without fine-grained sync, agents reason over outdated peer contributions and
  do redundant/inconsistent work ([arXiv:2502.14321](https://arxiv.org/abs/2502.14321)).
  This is the honest counterweight to passive awareness (ADR-241 F1) that radio
  **did not model** — passive mode's mid-task sharing can land *late*, and late
  is stale.
- **F3 [HIGH] / F4 [HIGH] — no universal winner; efficiency ≠ effectiveness.**
  The winner is topology-dependent, and token savings frequently do NOT convert
  to accuracy ([arXiv:2606.05304](https://arxiv.org/abs/2606.05304)). A policy
  that saves tokens but loses an answer is a hard fail no speedup buys back.
- **F5 [MED] — the optimum moves.** Static topologies underperform
  learned/adaptive ones under shifting/adversarial peers
  ([arXiv:2602.03688](https://arxiv.org/abs/2602.03688)).
- **F8 [HIGH] — coordination overhead dominates; digests cut it -45.7% tok**
  ([arXiv:2605.29612](https://arxiv.org/abs/2605.29612)) — already the ADR-241
  digest lever's grounding, extended here.

Full citations, confidence tags, and the mandatory "unreplicated preprints"
caveat live in `docs/research/RESEARCH-multi-agent-coordination.md`.

## Decision

Extend radio's genome with the two new SOTA findings and let the ADR-234/235
flywheel price them against the existing levers under the **frozen conjunctive
gate** with a never-optimized-against anchor topology, Ed25519-signed lineage,
and `verifyReplayBundle` required — the same discipline ADR-241 used, now over a
larger, SOTA-grounded lever set.

1. **`topology` lever — `message-passing` | `blackboard` (F6).** Grounds
   [arXiv:2510.01285](https://arxiv.org/abs/2510.01285) /
   [arXiv:2507.01701](https://arxiv.org/abs/2507.01701). `message-passing` is
   every ADR-241 behavior unchanged (per-agent posts + boundary folds, where the
   `digest`/`foldEvery`/`postPolicy` levers live). `blackboard` replaces
   free-form posts+folds with ONE validated shared board and a correct
   topic-filtered pull; its relevant-pull **subsumes** the message-passing
   delivery levers (under `blackboard` they go inert — the board *is* the
   digest). Root starts at `message-passing`, so the wheel must PRICE the
   blackboard against a tuned message-passing rung rather than being handed the
   answer.
2. **`stalenessCost` — an INTRINSIC rework surcharge (F9), NOT a lever.** Grounds
   [arXiv:2502.14321](https://arxiv.org/abs/2502.14321). Charged ONLY on LIVE
   async folds (mode `passive` with non-silent posting under `message-passing`):
   each cross-partition fact delivered to its owner is priced by its delivery
   **latency** (post lag + fold-cadence lag), and one rework step accrues per
   `1/stalenessCost` accumulated fact-rounds. It is EXACTLY 0 at the defaults
   (`foldEvery=1` + `immediate`) and 0 under `blackboard` (fine-grained pull is
   never stale) — so it does not perturb the ADR-241 ablation ordering; it is a
   real headwind the passive/late region must navigate. This is the honest
   counterweight radio previously MISSED.
3. **The existing ADR-241 levers stay in the genome** — `mode`
   (single/divide/negotiate/passive, F1), `foldEvery`, `postPolicy`, and
   `digest` (`full`/`mentions`/`relevant`, grounding CONCAT F8
   [arXiv:2605.29612](https://arxiv.org/abs/2605.29612)) — now co-evolved with
   topology under the same gate.
4. **Frozen-gate flywheel over the full genome** (`packages/radio/scripts/flywheel-radio.mjs`).
   Evolves `{mode, foldEvery, postPolicy, digest, topology}` from the
   deliberately bad root `divide / fold-every-4 / silent / full /
   message-passing` under the frozen `meetsPromotionRule`, a never-optimized-against
   cross-heavy anchor topology (different seeds), Ed25519-signed lineage, and
   `verifyReplayBundle` required (ADR-235 gate re-execution). F4's
   efficiency≠effectiveness discipline is encoded structurally: the gate's
   `regressed = unresolved → hard-gate stop` never lets a token saving buy back
   a lost answer. The wheel's job is to **discover** which SOTA combination wins
   *for this task family*, replayably — the concrete restatement of F3 ("no
   universal winner, so search, don't assert").

### Flywheel result

**Final policy: `{ mode: passive, foldEvery: 4, postPolicy: silent, digest:
full, topology: blackboard }`** (from the committed
`packages/radio/.radio-flywheel/tuned-policy.json`, schema
`radio-comms-tuning-v1`, run 2026-08-08). Lift curve 21.28 → 40.32 → 47.62 pts
over two anchor-surviving promotions (gen-1 flips topology to `blackboard`;
gen-2 flips mode to `passive`), `milestoneReached: true`, `replayVerified:
true`. This is coherent with the sim's design: the wheel converges on the
blackboard substrate (F6) with a live-aware mode (F1), and leaves
`foldEvery`/`postPolicy`/`digest` at their root values precisely because they go
**inert under `blackboard`** — the board is the digest and its pull is never
stale, so the staleness surcharge (F9) is structurally avoided rather than
tuned around. The frozen gate, not a human, made every promotion.

### What this is NOT (bounded claims, ADR-236 discipline)

- The sim is a **mechanism testbed, not a benchmark claim.** It gives the
  flywheel a real deterministic landscape and demonstrates that the levers price
  as the findings predict; it does **not** reproduce KramaBench's 37.53% or any
  SWE-Atlas number. A live LLM-pod run is the deferred next increment with its
  own measured ADR.
- The SOTA numbers (F1/F3/F4/F5/F6/F8/F9) are **unreplicated single-paper
  preprints on author-configured benchmarks.** They justify making each strategy
  an *evolvable lever*; they are not asserted as MetaHarness results.
- **`blackboard` and `stalenessCost` are faithful MODELS, not the papers' exact
  systems.** Blackboard is modeled as correct-by-construction shared state whose
  relevant-pull subsumes the delivery levers; staleness is modeled as a
  latency-priced rework surcharge. Both capture the finding's *mechanism and
  direction*, deliberately, for a deterministic testbed — neither is a port of
  the cited system.
- The blackboard rung is modeled to sit **just under** a fully-tuned
  message-passing rung on the frozen gate margin unless its token efficiency and
  no-staleness properties are decisive on the task — i.e. the wheel must earn
  the switch, it is not gifted.

## Consequences

- Radio's genome now spans five co-evolvable coordination levers grounded in
  seven fact-checked SOTA findings, with topology (F6) and an honest staleness
  cost (F9) added since ADR-241 — promotions gated, Ed25519-signed, and
  replay-verified (ADR-234/235), never hand-picked (F3/F5).
- The efficiency≠effectiveness hazard (F4) is encoded in the gate, not asserted
  in prose: no token saving is permitted to trade away a resolved answer.
- The passive-awareness lift (F1) now carries its honest counterweight (F9): the
  same sim that rewards mid-task sharing charges it for landing late, so the
  flywheel's convergence on `blackboard` is a *priced* choice, not a free lunch.
- Bounds stay visible: mechanism testbed not benchmark, unreplicated preprints,
  models not ports. Live LLM-pod validation of any of these levers is deferred
  to its own measured ADR before any host default changes.
