// SPDX-License-Identifier: MIT
//
// Benchmark layer — shared types (ADR-076).
//
// "Benchmark the parent versus the child, not the idea." Given the SAME repo,
// task set, model, budget, and sandbox: did the child beat its parent WITHOUT
// increasing risk? A child is promoted only when it clears five gates — solve,
// regression, safety, cost, repro — and the win is statistically real (the lower
// 95% bootstrap bound on the parent→child score delta is above zero), not one
// lucky run.
//
// This is the rigorous evaluation path used when a task set is supplied
// (`evolve --bench <suite>`). The lightweight ADR-072 scorer remains the default
// for a quick `evolve <repo>` with no task set.
export {};
//# sourceMappingURL=types.js.map