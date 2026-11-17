# @metaharness/energy

Experimental energy based constraint search for MetaHarness. A regular workspace
module, not a Git submodule or an enabled production scheduler. Runtime dependencies:
zero. Requires Node 20 or newer for the supplied benchmark tooling.

Inspired by [CRAM](https://arxiv.org/abs/2611.17309), a Compact Reasoning
Associative Memory. This is an independent discrete pairwise implementation,
not a reproduction of the paper's GPU kernels, focused Gibbs sampler, continuous
dynamics or measured speedups. No upstream code or model weights are bundled.

## Assignment proposals

```ts
import { assign, validateAssignment } from '@metaharness/energy';

const problem = {
  costs: [[1, 2], [1, 99]], // tasks by agents; null means denied
  budget: 4,
};
const result = assign(problem, {
  seed: 42, maxMoves: 4000, restarts: 8, temperature: 10,
});
if (result.state && validateAssignment(problem, result.state)) {
  console.log(result.state, result.score); // [1, 0], energy 3
  // Recheck current permissions and resource availability before execution.
}
```

One task per agent per scheduling wave. Costs are caller supplied preferences,
not calibrated failure probabilities. Aggregate budget uses the same units as
costs. Dependencies, time windows, token budgets, multi-task capacities and
currency conversion are not encoded by this adapter. Never use negative
preference scores as monetary spend without a separate accounting constraint.

## Pairwise models and local learning

```ts
import { fit, solve, evaluate } from '@metaharness/energy';

const model = {
  unary: [[0, 0], [0, 0]],
  pairs: [{ i: 0, j: 1, costs: [[0, 0], [0, 0]] }],
};
// Supply only independently verified examples from the same authorized scope.
const learned = fit(model, [[0, 0], [1, 1]], { epochs: 100 });
const problem = { ...learned.model, fixed: { 0: 1 } };
const result = solve(problem, { temperature: 0, seed: 42 });
if (result.state) console.log(evaluate(problem, result.state));
```

`fit` minimizes local conditional pseudolikelihood with SGD. It does not
differentiate through search. Null hard masks and fixed choices are immutable;
feasibility checks cannot establish the provenance of supplied examples. Learned
scores must never establish authorization. Training loss is not evidence of
production quality. Keep training and evaluation data separate in deployments.

`solve` returns only a state with zero modeled violations after full independent
recomputation. `optimal` is always false: no global optimum certificate is
provided. `budget_exhausted` means no validated candidate was found within the
search budget; it does not prove infeasibility. There is no continuous descent
guarantee for this stochastic discrete search. Floating point costs can cause
small path differences between implementations; use integer costs when exact
replay matters. Budget checks do not use an epsilon that permits overspending.

## Bounds and governance

* Maximum 1024 variables, 64 values per variable, one million model entries.
* Maximum one million moves and 1024 restarts, with seeded reproducible randomness.
* Training is limited to 64 variables, 1000 examples, 1000 epochs and a
  conservative 20 million candidate/edge work estimate.
* Inputs are copied, checked for finite costs and shape, and never modified.
* Sparse incident edge deltas are used automatically for graphs with at least
  16 variables and at most four edges per variable. Tiny or dense graphs use
  full recomputation. `incremental` overrides this for equivalence testing.
* No network, filesystem, tool execution, persistence, API calls or promotion
  occurs inside the library. Search budgets count work, not wall clock deadlines.
  Use an isolated worker with an external deadline for untrusted workloads.
* RuVector retrieval may supply scoped candidate costs and constraints; the
  caller must validate scope, identity and current permissions independently.
  No RuVector or ruv-fann runtime adapter is bundled in this version.
* Rollback is removal of the optional import; existing routing is unchanged.

## Validation and reproduction

From the repository root:

```sh
npm ci --ignore-scripts
npm run build --workspace @metaharness/energy
npm run lint --workspace @metaharness/energy
npm run test --workspace @metaharness/energy
node packages/energy/bench/assignment.mjs
node packages/energy/bench/sparse.mjs
```

Recorded results in `bench/validation.json` and `bench/sparse-validation.json`:

| Measure | Result |
| :--- | :--- |
| Synthetic assignment cases | 1000, with 906 feasible |
| Valid assignments returned | 906, zero invalid |
| Exact optima recovered | 904 of 906 feasible cases |
| Mean cost gap on returned feasible cases | 0.0178% |
| Greedy feasible assignments | 741, with 165 missed feasible cases |
| Energy automatic p95 | 1.348 ms |
| Exact enumeration p95 | 0.504 ms |
| Sparse chain graph mean speedup over full scoring | 2.37x |
| Sparse versus full result mismatches | 0 in both benchmarks |

These are single-process synthetic CPU results, not production replay or GPU
results. Exact enumeration was deliberately simple and unpruned; it is still
faster and more accurate on these small cases. The proposed 2x latency promotion
gate failed. Keep this package experimental and opt in. Do not replace the
production planner or claim LLM cost savings from this evidence.

Promotion requires real replay, comparison against an optimized exact solver,
zero accepted constraint violations, quality within 1% of the exact baseline,
and at least 2x lower planning cost or p95 latency than the current planner.
Case generation seed is 90001; search settings were evaluated first on 200
development cases with seed 12345. Neither seed represents real customer data.
