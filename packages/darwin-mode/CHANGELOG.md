# Changelog — @metaharness/darwin

All notable changes to this package. Dates UTC.

## 0.3.1 — 2026-06-21

- Docs: README now covers the full SWE-bench ladder (incl. **58.3%** 3-tier + agentic 31.3%) and a **Darwin Shield** section (the v0.3.0 defensive security application); npm description updated to the dual-application story. No code change.

## 0.3.0 — 2026-06-21

- **Darwin Shield (ADR-155): defensive zero-day discovery harness** (`src/security/`,
  exported as `security`). The security application of the Darwin Plus stack —
  same thesis (model frozen, harness evolves, proof in the replayable receipt),
  changed task (defensive vulnerability discovery) and fitness function.
  - Genome (planner/contextPolicy/reviewerCount/retryBudget/fuzzBudget/tools),
    bounded mutation + crossover (`safetyProfile` immutable), three fixed
    baselines (static / LLM single-pass / fixed agent).
  - Safety layer: scope gate, exploit redactor, unsafe-output gate
    (`exploitCodeAllowed` is a hard `false`; unsafe outputs are an immediate
    −1.00 fitness term).
  - ruVector security memory: 7 collections, hybrid + negative-memory ranking,
    patch/genome reuse so runs compound.
  - DARWIN-SHIELD-BENCH on a seeded corpus passes every ADR-155 gate at the
    documented config (pop 16 × 50 cycles): TPR +150% vs fixed harness, FPR −100%,
    patch-pass 100%, repro 100%, **0 unsafe outputs**, cost ≤ 2×. Fully
    deterministic (byte-identical receipts). Run: `npm run bench:shield` or
    `metaharness-darwin security bench`.

## 0.2.8 — 2026-06-21

- **Agentic loop measured at scale (ADR-153)**: the ReAct loop (read/grep/ls/edit/run_tests/submit) on deepseek-v4-pro = **94/300 = 31.3%** [26.3,36.8] (275 attempted, official batch). Competitive with single-shot+repair (29.3%) and CHEAPER (~$0.04/inst vs $0.11) — conservative lower bound (budget-truncated). RESULTS §20.

## 0.2.7 — 2026-06-20

- LEARNINGS.md brought current with the full batch-verified arc: §5 N-tier ladder (29.3→40.3→**58.3%**), §6 capability floor now the rigorous local-14b full-300 number (4.7→6.7%), verdict updated (paradigm reaches 58.3%, both frontiers exhausted). Agentic loop (ADR-153) now implemented + unit-tested (`bench/swebench/agentic-loop.mjs` + `solve-agentic.mjs`) — the next-arc architecture, shipped as code.

## 0.2.6 — 2026-06-19

- **3-tier hybrid = 175/300 = 58.3%** [52.7,63.8] on full SWE-bench Lite (ADR-154), VERIFIED (55/55 sage-added reproduced). v4-pro(88)->sonnet Scholar(+33)->opus Sage(+54). 7.6x the 7.7% baseline; conservative lower bound (Sage partial). Blended ~$0.74/instance.

## 0.2.5 — 2026-06-19

- New ceiling (ADR-152): **v4-pro + Scholar hybrid = 121/300 = 40.3%** [34.9,46.0] on full SWE-bench Lite — 5.2x the 7.7% baseline. Two levers stack: stronger cheap base (v4-pro, 88/300) + frontier-tail escalation (sonnet-4 recovers 33/212). Blended ~$0.39/instance.

## 0.2.4 — 2026-06-19

- New result (ADR-151): swapping the cheap base deepseek-V3 -> deepseek-v4-pro nearly doubles the repair floor **15.3% -> 29.3%** [24.5,34.7] on full SWE-bench Lite (same harness). Falsifies "paradigm exhausted regardless of model IQ."

## 0.2.3 — 2026-06-19

- Add `LEARNINGS.md` — the measured findings distilled into harness defaults (repair=2x lever, cost-routing, Barbarian&Scholar tiering, format-contract, batch-eval discipline, capability floor).

## 0.2.2 — 2026-06-19

- **Docs: full SWE-bench Lite (300) evidence ladder** now in the description + README, all official `swebench` Docker harness, batch-verified:
  - open-loop **7.7%** [5.2, 11.2] (ADR-144)
  - + localization **8.0%** [5.4, 11.6] (ADR-146)
  - + closed-loop repair **15.3%** [11.7, 19.8] (ADR-149)
  - + Barbarian&Scholar hybrid (cheap base + frontier-tail escalation) **33.3%** [28.2, 38.8] (ADR-148)
- Blended cost ~$0.01/instance (cheap) → ~$0.34/instance (hybrid) vs $1–20/instance for frontier agents.
- README now links `bench/results/RESULTS.md` (the full reproducible evidence) for npm-only readers.
- `RuvllmMutator` (local/$0 air-gapped mutator, ADR-259) ships in `dist/`.
- Added `bench/swebench/KNOWN_FLAKY.md` (standing `psf__requests-2317` Docker-hang exclusion note).

## 0.2.1 — 2026-06-19

- Metadata: repositioned as "an LLM supercharger and cost optimizer"; keywords/description.

## 0.2.0 — 2026-06-18

- Integrated into the `metaharness` scaffolder (`npm run evolve`, ADR-147).
- Evolutionary stack (mutation + crossover + diverse selection + graded promotion) over a frozen core.

## 0.1.x — 2026-06

- Initial release: frozen-model / evolving-harness over 7 mutation surfaces; deterministic mutator default; `validateGeneratedCode` safety gate; pluggable `CodeGenerator`.
