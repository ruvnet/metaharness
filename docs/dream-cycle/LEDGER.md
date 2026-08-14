# MetaHarness Dream Cycle — Ledger

Durable memory across nightly Dream Cycle runs. One row per night. See
`docs/dream-cycle/${DATE}-gist.md` (or the published gist) and the linked
issue/PR for full detail.

| Date | Deep | Finding | Issue | PR | Evaluated? | Verdict | Effect | Witness | Prior-night fates |
|---|---|---|---|---|---|---|---|---|---|
| 2026-08-13 | security-adversarial | Added `indirect_prompt_injection` (OWASP LLM01 indirect, CVE-2025-32711-backed) as redblue's 6th attack family; independent critic caught+fixed a keyword-collision confound before ship | #180 | #181 | yes | ACCEPT-WITH-CAVEATS | live spend $0.00042, 0/6 offline-suite regression, vacuous true-negative on the new family (target has no tool-channel model) | `398c71a6...` | n/a (first ledger entry) |
| 2026-08-14 | host-adapters | Fixed hermes YAML mapping-key injection (`AgentSpec.name`/`HarnessSpec.name` unescaped into `agent.personalities.<name>:`) in all 3 byte-for-byte-parity codegen paths (adapter, CLI scaffold, web-UI); critic caught+fixed a reserved-bare-scalar hazard (`true`/`null`/`123`) pre-ship and flagged 2 still-open sibling gaps (comment-line + MCP-value injection), disclosed not hidden | #187 | #188 | yes | ACCEPT-WITH-CAVEATS | 19+15+18/18 tests green (13→19, 13→15, 16→18), 0 regressions across 454+69 unaffected full-suite tests, deterministic before/after repro (no live spend) | `1e859efa...` | #180/#181 MERGED |
