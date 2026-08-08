# Multi-Agent Coordination — a cited research report

**Date**: 2026-08-08
**Project**: `ruvnet/metaharness`
**Scope**: grounding research for `@metaharness/radio` (ADR-241) and the SOTA
coordination levers (ADR-243). Organized by five research sub-questions.

> **Overarching caveat — read first.** Every headline number below is
> **self-reported** in a **single-paper preprint** (arXiv, not yet
> peer-reviewed), measured on a benchmark the paper's own authors selected and
> configured, with **no independent replication** at the time of writing. The
> ablations are internally consistent and the mechanisms are plausible, but the
> magnitudes should be read as *directional evidence*, not settled fact. They
> are strong enough to justify making each coordination strategy an **evolvable
> lever under a frozen gate** (the MetaHarness thesis) — they are **not** strong
> enough to justify hand-picking one strategy and asserting its numbers as our
> own. Where this report cites a percentage, it is the paper's number on the
> paper's setup; MetaHarness reproduces only *ordering/mechanism* on its own
> deterministic sim, never the benchmark scores (see ADR-241 / ADR-243 honest
> bounds).

Confidence tags (`[HIGH]` / `[MED]`) are the fact-check confidence carried from
a 107-agent adversarially vote-verified deep-research run, not a claim about the
underlying paper's statistical power.

---

## Q1 — Does asynchronous / passive awareness help?

**Finding F1 [MED] — AgentRadio.** In long-horizon multi-agent collaboration,
letting agents share discoveries **mid-task** (rather than only at phase
boundaries) is the single largest recoverable loss. AgentRadio reports **62.1%
vs 32.3%** for four agents vs a single agent of the same model on **SWE-Atlas**
(124 tasks / 1,306 rubrics). The mechanism is one primitive: `wait_for_mention`
backgrounded as an OS-level task rather than an LLM step, so listening is free
and an @-mention is folded in at the next step boundary with a full thread
snapshot. Source: [arXiv:2607.28430](https://arxiv.org/abs/2607.28430).
**Confidence: MED.**

The paper's own ablation locates the lift: naive partition +7.2 pts, negotiated
partition +12.1 pts (largest single layer), passive awareness +10.5 pts
(p = 0.0023). Passive awareness is net-positive but **not free** — see Q5.

MetaHarness status: implemented as radio's passive mode (ADR-241). The sim
reproduces the ablation *ordering* (passive < negotiate ≤ divide < single in
steps-to-resolve), not the SWE-Atlas scores.

---

## Q2 — What coordination topology wins? (message-passing vs blackboard vs learned)

**Finding F3 [HIGH] — PACT: no universal winner.** There is **no single
communication strategy that is universally optimal** — the best strategy is
**topology-dependent**. On the strategies studied, **action-centered / compact**
information exchange wins, cutting **-38.7% tokens** versus verbose alternatives.
Source: [arXiv:2606.05304](https://arxiv.org/abs/2606.05304). **Confidence:
HIGH.** *This is the load-bearing justification for MetaHarness treating each
coordination strategy as an evolvable lever under a frozen gate, rather than
hand-picking one.*

**Finding F6 [HIGH] — blackboard / shared structured state.** A **blackboard**
(shared, structured, validated state) beats **both** free-form message-passing
**and** master-slave orchestration: **37.53% vs 32.16%** on **KramaBench**, and
is more **token-efficient** — because agents mutate a validated shared state
instead of exchanging free-form dialogue. Sources:
[arXiv:2510.01285](https://arxiv.org/abs/2510.01285) /
[arXiv:2507.01701](https://arxiv.org/abs/2507.01701). **Confidence: HIGH.**

**Finding F5 [MED] — static vs learned/adaptive topologies (TodyComm).** Static
topologies **underperform learned/adaptive** ones when peers are **shifting or
adversarial** — i.e. a fixed graph that is optimal for one regime degrades when
the peer distribution changes. Source:
[arXiv:2602.03688](https://arxiv.org/abs/2602.03688). **Confidence: MED.** This
strengthens F3: not only is there no static universal winner, the optimum
*moves*, which is precisely the case for a discover-per-task search rather than a
one-time design choice.

MetaHarness status: topology is a lever (`message-passing` | `blackboard`) in
the radio sim; blackboard is a faithful *model* (correct-by-construction shared
state whose relevant-pull subsumes the message-passing delivery levers), not the
papers' exact systems (ADR-243).

---

## Q3 — What communication policy / digest cadence minimizes overhead?

**Finding F8 [HIGH] — CONCAT: coordination overhead dominates.** Coordination
overhead is the **dominant cost** in multi-agent runs, and **digest / summarizer**
methods cut it — **-45.7% tokens**. Source:
[arXiv:2605.29612](https://arxiv.org/abs/2605.29612). **Confidence: HIGH.** This
is the direct evidence behind radio's digest lever (`full` | `mentions` |
`relevant`): a reader need not digest whole thread snapshots.

**Finding F3 [HIGH] (again) — compact/action-centered content.** From PACT
above: the *content* policy matters as much as cadence — action-centered/compact
messages save **-38.7% tokens** over verbose exchange, and which content policy
wins is topology-dependent. Source:
[arXiv:2606.05304](https://arxiv.org/abs/2606.05304). **Confidence: HIGH.**

**Finding F4 [HIGH] — efficiency gains ≠ effectiveness gains.** Critically,
token (efficiency) gains **frequently do NOT translate** into accuracy
(effectiveness) gains. A policy that saves tokens but *loses answers* is a hard
failure that no speedup buys back. Source:
[arXiv:2606.05304](https://arxiv.org/abs/2606.05304). **Confidence: HIGH.** This
is why the MetaHarness gate encodes `regressed = unresolved → hard-gate stop`:
cost is a secondary axis, never permitted to trade away a resolved answer.

MetaHarness status: `{digest, foldEvery, postPolicy}` are levers on the
message-passing rung; under `blackboard` the board *is* the digest, so these
levers go inert (ADR-243). The frozen conjunctive gate refuses any promotion
that regresses resolution regardless of token savings.

---

## Q4 — Is there evidence multi-agent beats single-agent?

Yes, on the papers' own benchmarks, in two independent settings:

- **F1 [MED]** — AgentRadio: **62.1% (4 agents) vs 32.3% (1 agent)** on
  SWE-Atlas, same underlying model — the lift is coordination, not a stronger
  model. [arXiv:2607.28430](https://arxiv.org/abs/2607.28430).
- **F6 [HIGH]** — blackboard multi-agent: **37.53% vs 32.16%** on KramaBench,
  beating both message-passing and master-slave multi-agent baselines *and*
  single-orchestrator setups, more token-efficiently.
  [arXiv:2510.01285](https://arxiv.org/abs/2510.01285) /
  [arXiv:2507.01701](https://arxiv.org/abs/2507.01701).

Both are within-model comparisons (the gain is attributed to structure, not to a
bigger model), which is the cleanest form the evidence takes. **But** re-read the
overarching caveat: these are self-reported single-paper preprints on
author-configured benchmarks with no independent replication. The honest reading
is "coordination structure produces real, ablation-located lift on these tasks,"
not "multi-agent is universally +30 pts." F4 is the standing reminder that the
lift is conditional on not losing answers to overhead.

---

## Q5 — Honest limits and failure modes

**Finding F9 [HIGH] — state staleness is async coordination's signature failure.**
Asynchronous coordination's characteristic failure mode is **state staleness**:
without fine-grained synchronization, agents reason over **outdated peer
contributions**, producing **redundant or inconsistent** work. Source:
[arXiv:2502.14321](https://arxiv.org/abs/2502.14321). **Confidence: HIGH.** This
is the honest counterweight to passive awareness (Q1): the same "share
mid-task, fold at boundary" mechanism that recovers lost information can, when
folds land late, cause agents to act on a stale view. The AgentRadio work (F1)
does **not** model this cost; ADR-243 adds it as an intrinsic rework surcharge
(priced by delivery latency) so the flywheel must navigate it rather than ignore
it.

**Finding F4 [HIGH] — efficiency ≠ effectiveness (restated as a failure mode).**
A token-cutting policy that regresses accuracy is a hard fail. Source:
[arXiv:2606.05304](https://arxiv.org/abs/2606.05304). **Confidence: HIGH.**

**Passive-awareness derailment (F1, [MED]).** In AgentRadio's own ablation the
passive layer **gained 47 rubrics and lost 23** — a mid-execution message can
pull an agent off a passing line of reasoning. Net-positive, not free. The paper
also notes awareness **cannot surface a conclusion no agent forms** (it moves
information, not insight) and ships **no relevance filter** (full snapshots,
agent-interpreted relevance). Source:
[arXiv:2607.28430](https://arxiv.org/abs/2607.28430).

**No universal optimum (F3, [HIGH]) + moving optimum (F5, [MED]).** Because the
best strategy is topology-dependent (F3) and degrades under shifting/adversarial
peers (F5), any single hand-picked configuration is a *local* bet that a
distribution shift can invalidate — the failure mode the discover-per-task
flywheel exists to hedge.

---

## Summary table

| # | Conf | Claim | Source | Sub-Q |
|---|------|-------|--------|-------|
| F1 | MED | Passive mid-task awareness: 62.1% vs 32.3% single-agent (SWE-Atlas) | [arXiv:2607.28430](https://arxiv.org/abs/2607.28430) | Q1, Q4 |
| F3 | HIGH | No universal comms strategy; topology-dependent; compact/action-centered wins (-38.7% tok) | [arXiv:2606.05304](https://arxiv.org/abs/2606.05304) | Q2, Q3, Q5 |
| F4 | HIGH | Efficiency (token) gains frequently ≠ effectiveness (accuracy) gains | [arXiv:2606.05304](https://arxiv.org/abs/2606.05304) | Q3, Q5 |
| F5 | MED | Static topologies underperform learned/adaptive under shifting/adversarial peers | [arXiv:2602.03688](https://arxiv.org/abs/2602.03688) | Q2, Q5 |
| F6 | HIGH | Blackboard beats message-passing AND master-slave: 37.53% vs 32.16% (KramaBench), more token-efficient | [arXiv:2510.01285](https://arxiv.org/abs/2510.01285) / [arXiv:2507.01701](https://arxiv.org/abs/2507.01701) | Q2, Q4 |
| F8 | HIGH | Coordination overhead is the dominant cost; digest/summarizer cut it -45.7% tok | [arXiv:2605.29612](https://arxiv.org/abs/2605.29612) | Q3 |
| F9 | HIGH | Async signature failure = STATE STALENESS (reasoning over outdated peer state → redundant/inconsistent work) | [arXiv:2502.14321](https://arxiv.org/abs/2502.14321) | Q5 |

*Provenance: fact-checked SOTA findings from a 107-agent deep-research run, each
adversarially vote-verified. All figures are self-reported single-paper
preprints on author-configured benchmarks with no independent replication yet
(see overarching caveat).*
