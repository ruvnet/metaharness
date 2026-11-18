# @metaharness/energy

Experimental constraint planning for MetaHarness, with zero runtime dependencies.
The assignment adapter uses classical exact matching by default. Generic pairwise
energy search and local pseudolikelihood learning remain available separately.
This workspace package is not enabled in the production planner.

The energy experiment is inspired by [CRAM](https://arxiv.org/abs/2611.17309).
It does not reproduce its GPU implementation, continuous dynamics, focused Gibbs
sampler or reported speedups. No upstream code or model weights are bundled.
The exact assignment path is an independent rectangular Hungarian implementation,
based on classical [assignment duality](https://www.math.toronto.edu/mccann/1855/KuhnNRL55.pdf).

## Exact assignment proposals

```ts
import { assign, verifyAssignmentCertificate } from '@metaharness/energy';

const problem = { costs: [[1, 2], [1, 99]], budget: 4 };
const result = assign(problem, { maxOperations: 100_000 });
if (result.state && result.optimal && result.certificate &&
    verifyAssignmentCertificate(problem, result.state, result.certificate)) {
  console.log(result.state, result.score); // [1, 0], energy 3
  // Recheck current permissions and resources before executing any proposal.
}
```

Rows are tasks, columns are agents; null denies a pairing. Exactly one agent
per task and at most one task per agent per scheduling wave. Aggregate budget
uses the same units as costs. Dependencies, time windows, multiple tasks per
agent, separate spend and utility objectives are not encoded by this adapter.
Never use negative preference scores as monetary spend without separate accounting.

The exact algorithm uses O(tasks * tasks * agents) work and O(tasks + agents)
auxiliary memory after the normalized cost matrix. It does not expand exclusivity
into quadratic pair tables. `maxOperations` counts edge inspections, defaults to
one million, and is capped at ten million. It is not a wall clock deadline.
Search options such as `seed` and `maxMoves` only apply to the energy strategy.

Safe integer cost optima receive `optimal: true` only after a separate primal/dual
check establishes feasibility, tight matched edges, nonpositive column potentials,
zero unused column potentials and equality of primal and dual objectives. Public
`verifyAssignmentCertificate` checks a supplied certificate and budget independently.
Certificates establish the modeled minimum, never permission to act.

Fractional costs are accepted, but never receive an integer optimality certificate.
No epsilon permits budget overspend. Prefer integer accounting units when exact
replay and certified optima matter. Cost magnitudes are at most 1e9; aggregate
budget magnitudes may reach Number.MAX_SAFE_INTEGER.

| Status | Meaning |
| :--- | :--- |
| valid | Independently validated candidate; inspect optimal for certification |
| infeasible | Exact path found no full matching, or certified minimum exceeds budget |
| budget_exhausted | Operation/move limit, heuristic failure or uncertified numeric budget rejection; no infeasibility proof |

To explicitly use the original heuristic adapter:

```ts
const candidate = assign(problem, {
  strategy: 'energy', seed: 42, maxMoves: 4000, restarts: 8, temperature: 10,
});
// candidate.optimal is false even if it happens to reach the global minimum.
```

## Pairwise search and local learning

```ts
import { fit, solve, evaluate } from '@metaharness/energy';
const model = {
  unary: [[0, 0], [0, 0]],
  pairs: [{ i: 0, j: 1, costs: [[0, 0], [0, 0]] }],
};
const learned = fit(model, [[0, 0], [1, 1]], { epochs: 100 });
const clamped = { ...learned.model, fixed: { 0: 1 } };
const result = solve(clamped, { temperature: 0, seed: 42 });
if (result.state) console.log(evaluate(clamped, result.state));
```

`fit` uses local conditional pseudolikelihood SGD without differentiating through
search. Null hard masks and fixed values cannot be trained away. Labels are
copied into typed numeric arrays. Updates are projected to the accepted cost
range, and `clippedUpdates` reports projection. Returned models remain reusable.
Training loss alone does not establish generalization. Callers establish label
provenance and keep evaluation examples separate from training.

`solve` remains a bounded, incomplete stochastic local search. Its `optimal`
field is always false. Final full recomputation checks modeled feasibility;
neither fixed points nor low energy certify permission or a global minimum.
Sparse deltas are selected for graphs with at least 16 variables and at most
four edges per variable. Tiny or dense graphs use full scoring. `incremental`
forces either path for integer-cost equivalence tests. Fractional costs may
produce small path differences through floating point arithmetic.

## Bounds and integration

* Maximum 1024 variables, 64 values each, one million model entries.
* At most one million heuristic moves and 1024 restarts.
* Training: at most 64 variables, 1000 examples, 1000 epochs and a conservative
  20 million candidate/edge work estimate based on the copied example count.
* Inputs use dense bounded indexed copies. Caller iterators, map and slice
  methods cannot change copied shape or introduce string label indices.
* No persistence, network, tool execution, automatic promotion or mandatory
  RuVector/ruv-fann adapter. Retrieval may supply scoped preferences, but the
  caller validates identity, scope, permissions and current resource availability.
* This is synchronous computation, not a JavaScript sandbox. For untrusted
  workloads use parsed data and an isolated worker with an external deadline.
* Rollback is removal of the optional package import.

## Reproduction and evidence

```sh
npm ci --ignore-scripts
npm run build --workspace @metaharness/energy
npm run lint --workspace @metaharness/energy
npm run test --workspace @metaharness/energy
node packages/energy/bench/assignment-v2.mjs
node packages/energy/bench/sparse.mjs
```

Current report: `bench/assignment-v2-validation.json`. Historical v1 energy
reports remain in `bench/validation.json` and `bench/sparse-validation.json`.
The old energy-only assignment benchmark now explicitly selects strategy energy.

| Synthetic assignment measure | Exact default | Prior energy strategy |
| :--- | ---: | ---: |
| Feasible cases out of 1000 | 906 | 906 |
| Optima recovered | 906 | 904 |
| Invalid outputs | 0 | 0 |
| Mean cost gap | 0% | 0.0178% |
| Mean warm elapsed time per call | 0.00925 ms | 1.98141 ms |

The measured mean ratio is about 214x on this small synthetic distribution.
Exact calls are batched and amortized to reduce timer overhead; energy calls
are timed individually. These are warm local CPU measurements, not service
p95 or production agent cost savings. The improvement comes from selecting
classical matching for its native problem, not from a CRAM reasoning speedup.

All eight larger planted, permuted, offset and infeasible fixtures pass, including
64 by 64 assignments that exceeded the old pairwise expansion limit. A separate
400-case exhaustive property test includes negative costs, masks and rectangular
shapes. Certificate tampering, fractional budget boundaries and input mutation
have explicit regressions. See VALIDATION-v2.md for the final check receipt.

Keep opt in. Production promotion still requires real workload replay, comparison
against an optimized classical solver and the existing planner, zero accepted
constraint violations, quality within 1% of exact and at least 2x lower planning
cost or p95 latency than the current planner.
