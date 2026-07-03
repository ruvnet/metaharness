# ADR-229: RLI (Remote Labor Index) as the economic-workflow-performance oracle — internal target generation (primary) + tier-placement calibration (secondary)

- **Status**: Proposed
- **Date**: 2026-07-02
- **Deciders**: ruv
- **Tags**: metaharness, harnessaas, verticals, evals, target-generation, routing, tier-placement, cost
- **Source**: Scale AI / CAIS, *"Remote Labor Index: Measuring AI Automation of Remote Work"*, [arXiv:2510.26787](https://arxiv.org/abs/2510.26787) · live board [labs.scale.com/leaderboard/rli](https://labs.scale.com/leaderboard/rli) · sibling boards [MCP Atlas](https://labs.scale.com/leaderboard/mcp_atlas), [Coding](https://labs.scale.com/leaderboard/coding)
- **Research**: [`docs/research/rli-remote-labor-index.md`](../research/rli-remote-labor-index.md) — full deep-review with all numbers and links
- **Extends**: [[ADR-206]] (BenchPress tier placement)
- **Feeds / forward-ref**: harnessaas **ADR "RLI-Mini"** (in progress) — RLI-style tasks → workflow genomes → deliverable verifier packs → optimize cost-per-accepted-deliverable · harnessaas **ADR-0024** (Business Process Learning Harness)

---

## Context

### What RLI is, and why it is the right oracle for our product

RLI measures **end-to-end completion of real paid remote work**: **240 real Upwork freelance projects** (230 held-out + 10 public), across **23 domains**, median **11.5 h / $200** of human work (mean 28.9 h / $632.60), judged by expert humans on a single binary — *"would a reasonable client accept this as commissioned work?"* (the **Automation Rate**). 94.4% inter-annotator agreement; $30/task budget; 230/240 private ⇒ **contamination-resistant**. Full methodology, rankings, failure taxonomy, and sources are in [`docs/research/rli-remote-labor-index.md`](../research/rli-remote-labor-index.md).

RLI is the closest external analog to **the thing HarnessaaS actually sells**: an AI delivering a whole unit of economically-valuable business work to a standard a paying client accepts. That makes RLI far more than a leaderboard to quote — it is a **template for the internal north-star eval** our business-vertical learning loop must optimize against.

### The gap this closes

harnessaas ADR-0024 (Business Process Learning Harness) needs two things it does not yet have:
1. **Internal eval targets** — concrete, economically-grounded task+deliverable+acceptance-criteria bundles the vertical loop can optimize against. Without them, the loop has nothing external to aim at and drifts toward a **self-judged reward** (the exact failure RLI's data exposes: 45.6% of rejected deliverables are outputs the agent "finished" but that fail the human bar).
2. **A capability reality-check** — an honest ceiling so no vertical over-claims autonomy.

RLI supplies the template for both. Separately, its published *frontier ranking* also happens to answer a routing question we would otherwise pay to answer ourselves — a useful but **secondary** by-product.

---

## Decision

Adopt RLI as MetaHarness + HarnessaaS's **economic-workflow-performance oracle**. It has two applications, deliberately ordered — the primary one is target *generation*, not leaderboard consumption:

### A — PRIMARY: RLI as the internal workflow-TARGET GENERATOR (north-star eval)

**RLI is, first and foremost, how we generate the internal eval targets the vertical learning loop optimizes against.** Its task shape, acceptance standard, domain taxonomy, and ceiling seed the HarnessaaS **RLI-Mini** pipeline (separate harnessaas ADR, *in progress* — forward-referenced here):

```
RLI-style economic-work tasks
        │  (task shape + provided assets + client brief)
        ▼
  Workflow genomes            ← decompose each project into a governed
        │                       sub-task workflow (which tier does what,
        │                       where the human-approval checkpoints sit)
        ▼
  Deliverable verifier packs  ← operationalize "a reasonable client would
        │                       accept it" as concrete, held-out acceptance
        │                       criteria per deliverable type (NOT self-reward)
        ▼
  Optimize COST-PER-ACCEPTED-DELIVERABLE
        (the north-star objective the loop minimizes over time)
```

What RLI contributes to each stage:
- **Task shape → workflow-genome seeds.** RLI's real projects are the template for the economically-grounded tasks RLI-Mini decomposes into workflow genomes. We do not invent synthetic tasks; we mirror the shape of real paid work.
- **Acceptance standard → deliverable verifier packs.** RLI's *"a reasonable client would accept it"* is the **north-star** the ADR-0024 heuristic verifier must approximate. Verifier packs encode held-out, human-calibrated acceptance criteria — the antidote to self-judged reward.
- **23 domains → which verticals to target, banded by decomposability** (see Application C).
- **16% ceiling → difficulty reality-check** on generated targets (see Application D).
- **Objective → cost-per-accepted-deliverable.** The metric the vertical loop minimizes: not raw completion, not internal reward, but *governed cost to produce an externally-acceptable deliverable*, improving over time.

> This is the headline. RLI's primary value to us is **generative** — it produces the internal north-star targets and verifier standard for the vertical loop. Everything below (tier placement) is a secondary application of the same oracle. **See the harnessaas RLI-Mini ADR for the pipeline; this ADR establishes RLI as its source-of-truth oracle and sets the governing constraints.**

### B — SECONDARY: RLI as a tier-placement calibration signal (extends ADR-206)

As a by-product, RLI's published frontier ranking calibrates model tier placement — a question ADR-206 (BenchPress) otherwise answers by running $60–125/model of our own evals. We **import RLI as an external, contamination-resistant, frontier-only BenchPress score-matrix column** (`rli-automation-rate`, provenance `{source: scale-rli, url, date, gold: external}`) instead. Resulting placement for high-value verticals:

| Tier | Model | Signal | Role |
|---|---|---|---|
| **Sage** (high-value vertical deliverables) | **Fable-5** | RLI 16.10% — #1, ~2× next | Primary for whole-deliverable / high-value business work |
| **Failover** | **Opus-4.8** | RLI 8.33% — clear #2 | When Fable is unavailable (ADR-221) or over-budget |
| **Mid** | **Sonnet-4.5** | RLI 2.08% | Mid-complexity sub-tasks; not whole high-value deliverables |
| **Cheap** (bounded sub-tasks) | **GLM-5.1 / Kimi** | MCP Atlas 75.6% / 64.4% | Decomposed tool-shaped sub-tasks — placed via MCP Atlas, **not** RLI |

RLI constrains the *top* of the ladder; MCP Atlas + our gold data constrain the *cheap* tier; they compose. This is calibration — secondary to Application A.

### C — Business-vertical scoping: RLI domains define *where decomposition belongs* (connects to ADR-0024)

RLI projects are **11.5–28.9 h multi-file multimodal deliverables** — categorically **not** single cheap-executor tasks. Band the 23 domains by decomposability to steer both RLI-Mini target generation (A) and the ADR-0024 vertical roadmap:

| Band | RLI domains | Posture |
|---|---|---|
| **Decomposable now** | Data Entry & Transcription, Data Extraction/ETL, Translation & Localization, Market Research & Product Reviews, Presentation Design, parts of Data Analysis & Testing | Generate RLI-Mini targets first; cheap tier does sub-tasks, frontier reviews, light human checkpoint. |
| **Decompose-then-escalate** | Web Development, Web & Mobile Design, Management Consulting & Analysis, Corporate & Contract Law, Branding & Logo Design | Frontier (Fable/Opus) on hard sub-tasks; mandatory human checkpoint; not cheap-autonomous. |
| **Not viable near-term** | Video & Animation, 3D Modeling & CAD, Building & Landscape Architecture, Game Design & Development, Audio & Music Production, Art & Illustration, Product Design, NFT/AR/VR & Game Art, Interior & Trade Show Design | Out of scope for autonomous delivery; ~0–low even at the frontier; media pipelines dominate. |

Principle: **a vertical enters the loop only decomposed into sub-tasks each below its tier's demonstrated bar**, never as a whole RLI-class project handed to one executor.

### D — The honest ceiling (governing constraint, stated prominently)

> **Best automation on RLI is 16%. Even the frontier completes only ~1 in 6 real remote-work projects — and the dominant failure is confidently-produced work that is below the professional bar (45.6% poor quality, 35.7% incomplete).**

Our cheap-tier learning loop sits **far below** this. Our best cheap candidate (**cand-6**, a code-repair *screening signal* scoring below its own useful bar) is nowhere near autonomous delivery. Therefore:

- The product is **governed, measured, learning-over-time cheap automation of DECOMPOSABLE sub-tasks**, with **frontier escalation** and **human-acceptance checkpoints**, optimizing **cost-per-accepted-deliverable**.
- It is **NOT** RLI-class autonomous project completion; no vertical may be marketed or promoted as such.
- Progress is measured as *accepted-deliverable rate / cost-per-accepted-deliverable over time under governance*, benchmarked against the RLI ceiling as a reality check — not a target we claim to have hit.

This constraint is **load-bearing**: RLI-Mini target difficulty and any downstream vertical must be reconciled against it.

---

## Consequences

### Positive
- **The vertical loop gets an externally-grounded north-star to generate targets from** (Application A) — economically-real tasks + a human-acceptance verifier standard, directly mitigating the self-judged-reward risk in ADR-0024.
- **High-value tier placement is calibrated for free** (Application B) — Fable=Sage / Opus=failover / Sonnet=mid, from a contamination-resistant human-judged eval, no $60–125/model spend.
- **Cheap-tier confidence is externally corroborated** (MCP Atlas: GLM-5.1 75.6%) — decomposed sub-task automation is defensible near-term.
- **Expectations are calibrated in writing** — the 16% ceiling is a governing constraint protecting the roadmap from over-claiming.

### Negative / costs
- **RLI is frontier-only and a fast-moving snapshot** (2.5%→16% in ~9 months); the imported calibration column must be re-checked against the live board, not frozen. It can't place the cheap tier.
- **Generating and judging whole-deliverable targets is expensive** (up to $30/task RLI-style budget + human judging) — RLI-Mini must bound this (small target sets, reuse of the 10 public tasks, human-calibrated verifier packs).
- **Human-acceptance judging is subjective and non-reproducible** vs a unit test — the right bar for economic work, but it needs calibration discipline (multi-judge, agreement tracking à la RLI's 94.4%).

### Neutral
- The Scale **Coding** board is a stale 2024–25 snapshot (o1-mini top, no Fable/Opus-4.8/GLM) and is **not** used — only RLI and MCP Atlas are live signals.
- This ADR adds an oracle + generative source + calibration column; it does not change the per-request router (ADR-225) or the availability gate (ADR-221), which remain orthogonal.

---

## Alternatives considered

- **Treat RLI as just a leaderboard to quote.** Rejected — that discards its primary value: its task shape + acceptance standard are the template for the internal north-star eval the vertical loop needs. Consuming only the ranking wastes the generative signal.
- **Invent synthetic internal eval targets.** Rejected — untethered from real economic work, they'd re-introduce the self-judged-reward failure. RLI-style tasks are economically grounded and contamination-resistant.
- **Run our own economic-work eval for tier placement.** Rejected — prohibitively expensive and subjective; import the external column per ADR-206.
- **Chase RLI as a KPI ("we complete N% of RLI").** Rejected — the 16% ceiling and cand-6 reality make that dishonest near-term. RLI is a generative oracle and reality check, not a target we claim to hit.

---

## Test Contract

Documentation of an oracle/scoping decision (no runtime code); its "tests" are integration checks on RLI-Mini and BenchPress when they land:

- **T1 (primary)** — RLI-Mini generates workflow-genome targets + deliverable verifier packs whose acceptance criteria trace to the RLI *"reasonable client would accept it"* standard; a vertical cannot graduate supervised→autonomous without passing a verifier pack on a held-out sample (no promotion on internal reward alone).
- **T2 (primary)** — the vertical loop reports **cost-per-accepted-deliverable** as its optimization objective, benchmarked against the RLI ceiling as a reality check.
- **T3 (secondary)** — the BenchPress score matrix contains an `rli-automation-rate` column with external-gold provenance, flagged **frontier-only** (does not place the cheap tier).
- **T4 (constraint)** — no vertical config or marketing asserts whole-project autonomy; a review check flags any "fully autonomous delivery" claim for reconciliation against Application D.

---

## Links

- Research deep-review: [`docs/research/rli-remote-labor-index.md`](../research/rli-remote-labor-index.md)
- RLI paper: [arXiv:2510.26787](https://arxiv.org/abs/2510.26787) · live board: [labs.scale.com/leaderboard/rli](https://labs.scale.com/leaderboard/rli) · [remotelabor.ai](https://remotelabor.ai) · [scale.com/blog/rli](https://scale.com/blog/rli)
- Sibling boards: [MCP Atlas](https://labs.scale.com/leaderboard/mcp_atlas) · [Coding](https://labs.scale.com/leaderboard/coding) · independent: [Epoch AI — RLI](https://epoch.ai/benchmarks/rli)
- [[ADR-206]] BenchPress low-rank score prediction — the tier-placement layer Application B extends
- harnessaas **ADR "RLI-Mini"** (in progress) — the target-generation pipeline this oracle feeds (Application A)
- harnessaas **ADR-0024** Business Process Learning Harness — the vertical loop this anchors
- meta-llm **ADR-225** calibrated escalate-trigger · **ADR-221** Fable-5 availability gate (both orthogonal)
- Related internal research: `docs/research/cheap-vs-frontier/` (cheap-model tool-use parity, corroborated by MCP Atlas)
