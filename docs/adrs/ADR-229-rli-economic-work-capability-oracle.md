# ADR-229: RLI (Remote Labor Index) as the economic-work capability oracle for tier placement + vertical scoping

- **Status**: Proposed
- **Date**: 2026-07-02
- **Deciders**: ruv
- **Tags**: metaharness, routing, tier-placement, benchmarking, business-verticals, harnessaas, cost
- **Source**: Scale AI / CAIS, *"Remote Labor Index: Measuring AI Automation of Remote Work"*, [arXiv:2510.26787](https://arxiv.org/abs/2510.26787) · live board [labs.scale.com/leaderboard/rli](https://labs.scale.com/leaderboard/rli) · sibling boards [MCP Atlas](https://labs.scale.com/leaderboard/mcp_atlas), [Coding](https://labs.scale.com/leaderboard/coding)
- **Research**: [`docs/research/rli-remote-labor-index.md`](../research/rli-remote-labor-index.md) — full deep-review with all numbers and links
- **Extends**: [[ADR-206]] (BenchPress tier placement) · **Connects to**: harnessaas ADR-0024 (Business Process Learning Harness)

---

## Context

### The gap RLI fills

ADR-206 (BenchPress) made tier placement cheap by predicting benchmark aggregates from a few probes instead of running every eval. But its columns are **code/agentic** slices (SWE-bench, Aider, Terminal-Bench, our darwin/claude-p loops). None of them measure the thing our **business-vertical roadmap** (harnessaas ADR-0024, the Business Process Learning Harness) actually sells: *completing a whole unit of economically-valuable remote work to a standard a paying client would accept.* We had no external oracle for that axis — and running our own would be prohibitively expensive and subjective.

**RLI is that oracle.** It measures end-to-end completion of **240 real Upwork freelance projects** (230 held-out + 10 public), across **23 domains**, median **11.5 h / $200** of human work (mean 28.9 h / $632.60), judged by expert humans on a single binary: *"would a reasonable client accept this as commissioned work?"* (the **Automation Rate**). 94.4% inter-annotator agreement; $30/task budget; 230/240 private ⇒ **contamination-resistant**. See the research doc for full methodology and citations.

### What RLI tells us (verified, contamination-resistant, and free to us)

1. **Fable-5 is the economic-work frontier by ~2×.** Live board: Fable-5 **16.10%**, Opus-4.8 **8.33%**, Codex GPT-5.5 6.25%, Sonnet-4.5 2.08%. This ordering is exactly the frontier column BenchPress wants and we would otherwise pay $60–125/model to approximate.
2. **Our cheap tier is close to frontier on *bounded* agentic work.** Sibling MCP Atlas board: Fable-5 83.3%, Opus-4.8 82.2%, **GLM-5.1 75.6% (rank 7)**, Kimi-K2.5 64.4% — corroborating our own cheap-vs-frontier finding. The cliff is on *whole projects*, not tool-shaped sub-tasks.
3. **The ceiling is 16%.** Even the best agent completes only **~1 in 6** real projects; the dominant failures are **poor quality (45.6%)** and **incomplete (35.7%)** — confidently-produced work that is below the professional bar or partial.

### Why now

harnessaas ADR-0024 is defining the Business Process Learning Harness and its **heuristic verifier** (does the business outcome pass?). Left unanchored, that verifier risks becoming a **self-judged reward** — the exact failure RLI's data warns about (45.6% of rejects are outputs the agent "finished" but that fail the human bar). We should wire in the external acceptance standard *before* the vertical loop starts optimizing against a fuzzy internal signal. And Fable-5's placement should be nailed down now, since it drives the most expensive routing decision (high-value verticals).

---

## Decision

Adopt RLI as the **economic-work capability oracle** — a first-class, external, contamination-resistant eval that feeds BenchPress tier placement (ADR-206) and anchors the harnessaas ADR-0024 vertical loop. Concretely, five decisions:

### D1 — Tier placement: Fable = Sage tier for business/high-value verticals (extends ADR-206)

RLI independently confirms the frontier ordering, so we **import it as a BenchPress score-matrix column** (`rli-automation-rate`, provenance: external-gold, Scale, dated) rather than running our own economic-work eval. Resulting tier assignment for **business / high-value verticals**:

| Tier | Model | RLI signal | Role |
|---|---|---|---|
| **Sage** (high-value vertical outcomes) | **Fable-5** | 16.10% — #1, ~2× next | Primary for whole-deliverable / high-value business tasks |
| **Failover** | **Opus-4.8** | 8.33% — clear #2 | When Fable is unavailable (ADR-221 liveness gate) or over-budget |
| **Mid** | **Sonnet-4.5** | 2.08% | Mid-complexity vertical sub-tasks; not whole high-value deliverables |
| **Cheap (bounded sub-tasks)** | **GLM-5.1 / Kimi** | MCP Atlas 75.6% / 64.4% | Decomposed, tool-shaped sub-tasks — placement grounded in MCP Atlas, **not** RLI |

This is the ADR-206 thesis in action: RLI/MCP Atlas are **external eval columns we import for free**; we spend our own gold-scoring budget only on the columns Scale doesn't provide (our darwin/claude-p loops, cheap-model deltas). RLI constrains the *top* of the ladder; MCP Atlas constrains the *cheap* tier; they compose.

### D2 — Business-vertical scoping: RLI's domains define *where decomposition belongs* (connects to ADR-0024)

RLI's projects are **11.5–28.9 h multi-file multimodal deliverables** — categorically **not** single cheap-executor tasks. Map the 23 domains onto the ADR-0024 vertical roadmap by *decomposability*:

| Band | RLI domains | ADR-0024 posture |
|---|---|---|
| **Decomposable now** (text/data-centric; cheap-executor + light checkpoints) | Data Entry & Transcription, Data Extraction/ETL, Translation & Localization, Market Research & Product Reviews, Presentation Design, parts of Data Analysis & Testing | Viable **as decomposed sub-tasks** with human-acceptance gates; cheap tier does the sub-task, frontier reviews. |
| **Decompose-then-escalate** (structured but high-stakes/complex) | Web Development, Web & Mobile Design, Management Consulting & Analysis, Corporate & Contract Law, Branding & Logo Design | Frontier (Fable/Opus) on the hard sub-tasks; mandatory human checkpoint; **not** cheap-tier-autonomous. |
| **Not viable near-term** (heavy multimodal, hours-long single artifacts) | Video & Animation, 3D Modeling & CAD, Building & Landscape Architecture, Game Design & Development, Audio & Music Production, Art & Illustration, Product Design, NFT/AR/VR & Game Art, Interior & Trade Show Design | Out of scope for autonomous delivery; frontier scores ~0–low even at the frontier. Tooling/media pipelines dominate. |

The roadmap principle: **a vertical enters the ADR-0024 loop only decomposed into sub-tasks each below its tier's demonstrated bar**, never as a whole RLI-class project handed to one executor.

### D3 — Acceptance standard: RLI's "reasonable client would accept it" is the ADR-0024 verifier north-star

The harnessaas ADR-0024 heuristic verifier must approximate **human-acceptance**, not self-judged reward. We adopt RLI's standard explicitly:

- **North-star validation for vertical promotion** = human (or human-calibrated) acceptance against the *delivered client standard*, RLI-style — an accept/reject on the whole deliverable, not a partial-credit self-score.
- **Directly mitigates the fuzzy-verifier risk**: RLI's failure data (45.6% poor-quality, 35.7% incomplete) *is* the failure surface a self-judged reward would miss. A vertical is not "promoted" on internal reward alone; it must clear an external-style acceptance gate on a held-out sample before it graduates from supervised to autonomous.
- **File-integrity failures (17.6%)** become **deterministic harness guards** (export/format/open validation), independent of the model — cheap to add, removes a whole rejection class.

### D4 — The honest ceiling (governing constraint, stated prominently)

> **Best automation on RLI is 16%. Even the frontier completes only ~1 in 6 real remote-work projects — and the dominant failure is confidently-produced work that is below the professional bar.**

Our cheap-tier learning loop sits **far below** this. Concretely, our best cheap candidate (**cand-6**, a code-repair *screening signal* that scores below its own useful bar) is not remotely an autonomous-delivery capability. Therefore this ADR **sets expectations, not capability claims**:

- The product is **governed, measured, learning-over-time cheap automation of DECOMPOSABLE sub-tasks**, with **frontier escalation** and **human-acceptance checkpoints**.
- It is **NOT** RLI-class autonomous project completion, and no vertical may be marketed or promoted as such.
- Progress is measured as *sub-task acceptance rate over time under governance*, benchmarked against the RLI ceiling as a reality check — not as a target we claim to have hit.

This constraint is **load-bearing**: any downstream ADR or vertical that implies whole-project autonomy contradicts ADR-229 and must be reconciled against it.

### D5 — (Optional) "RLI-lite" internal probe for onboarding models to tiers

Stand up a small internal probe reusing the **10 public RLI tasks** (plus a handful of our own client-style deliverables) as a **periodic economic-work capability check** when onboarding a new model to a business tier. This extends the ADR-206 probe idea from code-slices to economic-work:

- Runs on model onboarding for a *business-tier* candidate (not every model — cheap-tier models are placed via MCP Atlas + our gold code data).
- Judged by the ADR-0024 human-acceptance gate (D3), on a tiny N — a **screening signal**, explicitly not a leaderboard-grade number (small-N noise ≫ signal; see ADR-206 §Consequences).
- Purpose: catch a candidate that looks strong on code/agentic columns but collapses on whole-deliverable business work *before* it is routed to a paying vertical.

---

## Consequences

### Positive
- **Frontier tier placement for high-value verticals is now externally grounded and free** — Fable=Sage / Opus=failover / Sonnet=mid, confirmed by a contamination-resistant human-judged eval instead of $60–125/model of our own spend.
- **Cheap-tier confidence is externally corroborated** (MCP Atlas: GLM-5.1 75.6%) — decomposed sub-task automation is a defensible near-term product, not a hope.
- **The fuzzy-verifier risk in ADR-0024 gets a concrete anchor** (human-acceptance north-star + held-out acceptance gate) before the vertical loop starts optimizing.
- **Expectations are calibrated in writing**: the 16% ceiling is documented as a governing constraint, protecting the roadmap from over-claiming.

### Negative / costs
- **RLI is frontier-only and a snapshot.** It constrains only the top of the ladder and moves fast (2.5%→16% in ~9 months); the imported column must be re-checked against the live board, not frozen. Cheap-tier placement can't lean on it.
- **D5 (RLI-lite) has real cost**: whole-deliverable tasks are expensive to attempt (up to the $30/task RLI budget) and require human judging. Scoped to business-tier onboarding only, on ~10 public tasks, to bound this.
- **Human-acceptance judging is subjective and non-reproducible** vs a unit test — the right bar for economic work, but it needs calibration discipline (multiple judges, agreement tracking à la RLI's 94.4%).

### Neutral
- The Scale **Coding** board is a stale 2024–25 snapshot (o1-mini top, no Fable/Opus-4.8/GLM) and is **not** used for placement — only RLI and MCP Atlas are treated as live signals.
- This ADR adds an eval *column* and a *scoping principle*; it does not change the per-request router (ADR-225 calibrated escalate-trigger) or the availability gate (ADR-221), which remain orthogonal.

---

## Alternatives considered

- **Run our own economic-work eval.** Rejected: prohibitively expensive (whole multi-hour deliverables), subjective, and duplicative of a contamination-resistant eval Scale already publishes. BenchPress logic (ADR-206) says import the external column instead.
- **Treat RLI as a target to hit.** Rejected: the 16% ceiling and our cand-6 reality make any "we complete N% of RLI" claim dishonest near-term. RLI is a *calibration oracle and reality check*, not a KPI to chase.
- **Ignore RLI, place tiers on code benchmarks only.** Rejected: code slices don't measure whole-deliverable business capability, which is precisely the high-value-vertical routing decision RLI informs.
- **Use RLI for cheap-tier placement too.** Rejected: RLI is frontier-only; MCP Atlas + our own gold data are the correct cheap-tier signals.

---

## Test Contract

This ADR is documentation of a placement/scoping decision (no runtime code), so its "tests" are integration checks on the BenchPress matrix and ADR-0024 loop when those land:

- **T1** — The BenchPress score matrix (ADR-206) contains an `rli-automation-rate` column with per-cell provenance `{source: scale-rli, url, date, gold: external}` and is flagged **frontier-only** (does not participate in cheap-tier completion).
- **T2** — The ADR-0024 vertical-promotion gate requires an external-style **human-acceptance pass on a held-out sample** before a vertical moves supervised→autonomous (D3); a vertical cannot graduate on internal reward alone.
- **T3** — No vertical config or marketing copy asserts whole-project autonomy; a lint/review check flags any "fully autonomous delivery" claim for reconciliation against D4.
- **T4** — (If D5 ships) the RLI-lite probe runs only for business-tier onboarding, judged by the D3 gate, and its output is labelled a screening signal (small-N), never a leaderboard number.

---

## Links

- Research deep-review: [`docs/research/rli-remote-labor-index.md`](../research/rli-remote-labor-index.md)
- RLI paper: [arXiv:2510.26787](https://arxiv.org/abs/2510.26787) · live board: [labs.scale.com/leaderboard/rli](https://labs.scale.com/leaderboard/rli) · [remotelabor.ai](https://remotelabor.ai) · [scale.com/blog/rli](https://scale.com/blog/rli)
- Sibling boards: [MCP Atlas](https://labs.scale.com/leaderboard/mcp_atlas) · [Coding](https://labs.scale.com/leaderboard/coding) · independent: [Epoch AI — RLI](https://epoch.ai/benchmarks/rli)
- [[ADR-206]] BenchPress low-rank score prediction — the tier-placement layer this extends
- harnessaas **ADR-0024** Business Process Learning Harness — the vertical loop this anchors (sibling repo)
- meta-llm **ADR-225** calibrated escalate-trigger (per-request routing — orthogonal) · **ADR-221** Fable-5 availability gate (liveness — orthogonal)
- Related internal research: `docs/research/cheap-vs-frontier/` (cheap-model tool-use parity, corroborated by MCP Atlas)
