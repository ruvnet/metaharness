# MetaHarness Dream Cycle — Ledger

Durable memory across nightly Dream Cycle runs. One row per night. See
`docs/dream-cycle/${DATE}-gist.md` (or the published gist) and the linked
issue/PR for full detail.

| Date | Deep | Finding | Issue | PR | Evaluated? | Verdict | Effect | Witness | Prior-night fates |
|---|---|---|---|---|---|---|---|---|---|
| 2026-08-13 | security-adversarial | Added `indirect_prompt_injection` (OWASP LLM01 indirect, CVE-2025-32711-backed) as redblue's 6th attack family; independent critic caught+fixed a keyword-collision confound before ship | #180 | pending | yes | ACCEPT-WITH-CAVEATS | live spend $0.00042, 0/6 offline-suite regression, vacuous true-negative on the new family (target has no tool-channel model) | `398c71a6...` | n/a (first ledger entry) |
