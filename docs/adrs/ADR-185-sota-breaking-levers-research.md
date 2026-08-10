# ADR-185 — SOTA-breaking levers beyond the empty-patch cascade (research → roadmap)

**Status**: Proposed (research complete; top-3 queued for n=25 → n=300 validation)
**Date:** 2026-06-24
**Related:** ADR-184 (Sovereign Evolution), SAKANA_FUGU report (§5), LEARNINGS §28 (cascade 51.3%), §30 (xcascade 56%)

## Context

Darwin's conformant cost-Pareto frontier stands at **GLM→Opus empty-patch cascade = 51.3% @ $0.267/inst (n=300)**,
with the cheap-model union ceiling at 45% and Opus-single at ~60% (n=25). Published SWE-bench leaders sit at 68–79%
but at $15+/inst and with documented contamination. We want levers that lift the **cheap-model** floor or sharpen
**escalation routing** — approaching frontier resolve at <$0.50/inst — without touching gold tests in-loop. A
deep-research pass (ruflo-goals:deep-researcher, 37 sources) produced the ranked menu below.

## Key finding: localization + selection are the true cheap-model bottleneck

- BM25 retrieves **no** oracle file in ~50% of instances at a 27K-token limit → this is *why* the cheap floor is ~34%.
  Every point of localization recall ≈ a point of resolve for cheap models ("the model never saw the right file").
- The correct patch is in the candidate set ~75% of the time even when single-sample fails (CORTEXA); Agentless's
  oracle ceiling (41% @ 300 candidates) ≈ our union ceiling (45%) → **selection is nearly as important as generation.**
- Leaderboard caution: OpenAI deprecated Verified after gold-patch memorization; UTBoost found false-positives in
  40.9% of Lite / 24.4% of Verified entries. Our official-Docker conformant n=300 is the trustworthy baseline.

## Ranked menu (full table in LEARNINGS / research artifact)

| # | lever | lift (abs) | $/inst | conformant | effort | evidence |
|---|---|---|---|---|---|---|
| 1 | **Function-level localization** (AST narrow file→function) | +3–5 | neutral/↓ | yes | **S** | High (controlled, p=0.0017) |
| 2 | **Entropy-guided adaptive compute** (logprob entropy → sample/escalate) | +5–9 | −15% | yes | M | High (EGSS: GLM-4.6 65.8→74.6) |
| 3 | **Diverse edit-format BoN** (2 formats × N=4-6 + judge) | +4–8 | +$0.02-0.08 | yes | **S** | High (CORTEXA 7-cand 2-format) |
| 4 | Fine-tuned code-retrieval embedding (NV-EmbedCode/SweRank) | +6–12 | +$0.05-0.15 | yes | M | High (CORTEXA 68.2%) |
| 5 | Cogenerated repro-test self-consistency gate (DGM/Otter) | +3–7 | +$0.01-0.03 | yes (model-written) | M | Medium |
| 6 | Context compression / observation masking (SWE-Compressor 57.6%) | +3–6 | −25% | yes | S–M | High |
| 7 | Probe-based pre-gen routing (activation probes) | +2–5 equiv | −20% | yes | L | Medium (needs logit access — API-only blocks it) |
| 8 | MASAI sub-agent specialization (isolation) | +2–5 | ~flat | yes | M | Medium |
| 9 | MCTS / SWE-Search tree | +5–10 rel | 3–5× | yes | L | High but **infra-blocked** (non-serializable Docker state) |
| — | Reflexion w/o execution · hunk-level synthesis | +0–2 / fragile | — | yes | — | Low — **do not pursue** |

## Decision

Pursue the **top 3** next — all conformant, cheap, composable, and aimed at the measured root cause (localization +
selection), not frontier brute force. Validate each on n=25 scouting → n=300 confirm before any leaderboard claim:

1. **Function-level localization** (effort S) — AST pass to narrow context to the issue's functions before editing;
   should lift cheap-model resolve AND shrink the empty-patch rate (→ cheaper xcascade escalation).
2. **Entropy-guided adaptive compute** (effort M) — track OpenRouter logprob entropy per ReAct step; commit early when
   confident, sample wider / escalate early when uncertain. Cheaper on easy, more capable on hard. Best single lift.
3. **Diverse edit-format BoN** (effort S) — add a 2nd edit format (we already have search/replace + line_edit) and run
   N=4-6 across formats; our LLM-judge already selects. Additive to the cross-model diversity (N=2-per-model) we use.

Deferred: #4 embedding-retrieval (M, high lift — fast follow), #6 context compression (S–M, cost win). Blocked/declined:
#7 probes (no activation access on OpenRouter), #9 MCTS (Docker-state), reflexion/hunk-synthesis (weak/fragile).

## Consequences

- A concrete, evidence-graded roadmap beyond the cascade; the top-3 are expected to compound (localization → better
  candidates → better selection) and plausibly push the cheap-cascade past today's 51.3% toward the ~60% Opus ceiling
  at a fraction of frontier cost.
- Each remains gated by the standing discipline: n=25 directional → n=300 authoritative → leaderboard only on measured.
- Sources + per-lever detail captured in the research artifact (37 citations; CORTEXA, EGSS, Agentless, MASAI, SWE-Search,
  SWE-Compressor, localization-granularity study, UTBoost, et al.).
