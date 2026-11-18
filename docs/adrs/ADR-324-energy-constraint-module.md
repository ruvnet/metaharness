# ADR 324: Experimental pairwise energy constraint module

**Status**: Implemented experimentally; production promotion deferred

Date: 2026-11-17

## Context

CRAM ([paper](https://arxiv.org/abs/2611.17309),
[authors' implementation](https://github.com/Prefrontal-AI/CRAM)) shows very fast
training and low inference arithmetic on particular constraint puzzles. This
does not establish faster agent planning or general reasoning. MetaHarness needs
a bounded, independently validated experiment before considering integration.

## Decision

Add `packages/energy` as the standalone TypeScript workspace package
`@metaharness/energy`. It offers discrete pairwise energy evaluation, seeded
bounded search with restarts and swap proposals, local pseudolikelihood SGD,
and a one-task-per-agent scheduling-wave adapter. This is an independent
implementation inspired by CRAM, not a faithful reproduction or Git submodule.

Revision 2 defaults the assignment adapter to exact rectangular Hungarian
matching. The generic energy experiment remains available through `solve` and
explicit `strategy: 'energy'`. Exact matching follows classical assignment
duality ([Kuhn 1955](https://www.math.toronto.edu/mccann/1855/KuhnNRL55.pdf));
its speedup must not be attributed to CRAM or general agent reasoning.

Hard constraints are explicit null masks, clamped values, uniqueness and an
aggregate assignment budget. They cannot be trained away. Feasible incumbents
are tracked; the result is checked by full model recomputation and, for the
adapter, a separate direct assignment validator. No learned threshold is a
permission or optimality certificate. No tools execute and no promotion occurs.

Sparse deltas use compiled adjacency and scratch edge marks to count each
affected edge once. Development measurements showed their overhead hurts tiny
graphs, so automatic selection uses full scoring there. Force either path for
deterministic differential validation with integer costs.

## Inputs, outputs and assumptions

| Operation | Input | Output | Assumption |
| :--- | :--- | :--- | :--- |
| Local search (`solve`) | Scoped unary and pair costs, masks, fixed values, seed and work budget | Valid candidate or budget exhaustion, no optimality claim | Caller encodes all required constraints |
| Generic search (`searchEnergy`) | Discrete unary and pair tables, clamps and a work cap | Rechecked feasible state, proven infeasibility or budget exhaustion, plus selected method | Exact paths require integer costs |
| Learning | Model and verified feasible labels | Separate model plus initial/final training loss | Caller establishes label provenance and evaluation split |
| Assignment | Rectangular task/agent costs and optional budget | Independently validated proposal | One task per agent per wave |

Limits bound variables, model entries, search moves, restarts and training work.
They are not real-time deadlines. Isolate untrusted work in a worker with an
external deadline. Permissions and resources must be checked again at execution.
No persistent state or mandatory runtime dependencies are introduced.

## Evidence and decision gate

Version 1: see `packages/energy/bench/validation.json` and `sparse-validation.json`.
On 1000 synthetic cases (906 feasible), search returns 906 valid assignments,
904 at the exact optimum, with zero invalid output and a 0.0178% mean cost gap.
Automatic scoring p95 is 1.348 ms versus exact enumeration at 0.504 ms.
The exact oracle is simple unpruned enumeration, not an optimized solver.
On 100 synthetic chain graphs, sparse mean latency is 2.37x lower than full
recomputation with identical results. Development used seed 12345; final
assignment validation uses a distinct seed, 90001, without retuning settings.

The correctness and 1% mean quality gates pass. The 2x latency gate fails.
Keep opt in; do not wire into the production planner. No LLM or token-cost
savings were measured. Future promotion needs real workload replay, an optimized
classical solver baseline, zero accepted violations, quality within 1%, and
at least 2x lower cost or p95 latency than the current planner.

Version 2: `bench/assignment-v2-validation.json` compares the same 1000 cases
using exact matching, the explicit prior energy strategy and an independent
exhaustive oracle. Exact matching recovers all 906 feasible optima, with zero
invalid output or false certificates. All eight larger planted, metamorphic
and infeasible fixtures pass, including 64 by 64 assignments. Mean warm CPU
time is roughly 214x lower than prior energy search on the small distribution.
Exact timing is batched and amortized; this is not a service p95 comparison.
No production promotion gate is satisfied by comparing two synthetic paths.

Revision 3 adds `searchEnergy` for finite pairwise optimization. Exact min-sum
dynamic programming solves an integer forest in one pass over the score tables
plus reconstruction. Bounded enumeration prunes cyclic integer problems using
the sum of factor minima as a lower bound. Both support hard masks, clamped
variables, heterogeneous domains and signed costs. Automatic routing selects
enumeration for cyclic spaces up to 65,536 admissible unary combinations and
seeded local search for larger cyclic spaces or fractional costs. Explicit
strategies let callers control that tradeoff. A budget-limited exact run may
return a feasible incumbent. Only completed exact runs can prove an optimum
or infeasibility. The stochastic `solve` entry point keeps its existing contract.
See `packages/energy/bench/generic-search-validation.json` for reproduction
settings, independent oracle outcomes and the larger cyclic fallback fixtures.

## Consequences

The assignment adapter now defaults to a bounded rectangular Hungarian path,
without pairwise exclusivity table allocation. Generic energy search remains
available through `solve` and explicit `assign(..., { strategy: 'energy' })`.
Safe integer optima receive independently checked primal/dual certificates;
floating point outputs never claim certified optimality. Exact operation
exhaustion is distinct from proven matching infeasibility.

Input normalization uses bounded indexed copies instead of caller iterators or
slice methods. Labels are copied into typed numeric arrays before learning, and
updates are projected to the accepted cost range with a clipping counter.

## Alternatives and rollback

Greedy assignment is cheapest but misses feasible cases in this fixture.
Exact optimization is preferred for the tested small assignment workloads.
The generic energy module remains an experiment for larger pairwise preference
problems and locally learned constraints. Rust, WASM, GPU, ruv-fann and RuVector
adapters are deferred until measurements justify them.

Rollback: remove the optional package import. Existing planner behavior,
credentials, storage and routing remain unchanged.
