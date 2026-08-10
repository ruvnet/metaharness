# ADR-179 — Cost–Performance Pareto leaderboard (Value Score, multi-benchmark, public)

**Status**: Accepted (live: https://ruvnet.github.io/agent-harness-generator/cost-pareto.html)
**Date:** 2026-06-23
**Related:** ADR-178, the Studio (apps/web-ui)

## Context

Public SWE-bench leaderboards rank by raw resolve % only, hiding cost. Darwin's whole thesis is
**resolve-per-dollar** (34% @ $0.005/inst; full-300 sweep for ~$1.50 vs $750+ for frontier scaffolds). We
needed a public surface that ranks on *both* axes honestly, without overclaiming a rank we can't verify.

## Decision

A dark-mode, self-contained page shipped alongside the Studio on GitHub Pages (Vite `public/`), cross-linked.

- **Value Score (the calculus):** `Value = w·Capability + (1−w)·Cheapness`, where Capability = resolve %
  (0–100) and Cheapness = log-scaled cost mapped $5/inst→0, $0.005/inst→100. A slider sets `w` (default 0.5);
  the table re-sorts live. Log scale because $2→$1 should weigh like $0.02→$0.01.
- **Three boards (tabs):** Lite (300), Verified (500), Pro (Scale SEAL 731). Data-driven from
  `assets/swe-pareto.json` (fetch, cache-busted).
- **Honesty contract (load-bearing):** official resolve % are REAL (swe-bench/experiments, Scale SEAL); their
  cost is ESTIMATED from disclosed model × public token pricing (marked `est`; `undisclosed` where none).
  Darwin entries are MEASURED (resolve via official harness; cost from real API spend) and conformant.
  Darwin appears only where actually run (Lite); Verified/Pro show a "not yet run" banner.
- **Run total column** = cost × benchmark size, to make the economics concrete.
- A workbook explainer modal (side nav, scrollspy, SVG illustrations + animations) explains every term.

## Consequences

- A defensible "cost-Pareto frontier" claim — never an unverified absolute rank.
- Updating one JSON refreshes both chart + table; deploy via the existing `pages.yml`.
- Pitfall fixed: table rows must be HTML (`createElement`), not the SVG-namespace helper (empty rows bug).
