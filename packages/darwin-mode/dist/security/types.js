// SPDX-License-Identifier: MIT
//
// Darwin Shield — shared types (ADR-155). The integration contract for the
// defensive vulnerability-discovery harness. Every module codes against these.
//
//   model_frozen = true ; harness_evolves = true ; unsafe_output = rejected
//
// The thesis (ADR-077/155): the foundation model is frozen; only the HARNESS
// evolves — planner, retrieval policy, reviewer count, retry budget, toolset,
// model mix, fuzz budget. Findings are validated by tests/fuzzers, stored in
// ruVector memory so the system compounds, and every output passes a hard
// safety gate before it leaves the sandbox.
export {};
//# sourceMappingURL=types.js.map