# @metaharness/projects

> **Darwin Mode mutates structured policies, not prompts.**
> Borrowed-pattern integration program for Darwin Mode — ADR-156…166.

This package implements the ten load-bearing patterns the agent-tooling field has converged on, absorbed into Darwin Mode as **dependency-free, deterministic, replayable** modules. The opportunity is to *copy the pattern, not the product*: each module is a native MetaHarness artifact built on Node built-ins and a single shared core, with its own tests and a benchmark that measures the optimization it claims.

The through-line is one typed object — the **policy** Darwin mutates — not a prompt blob:

```ts
import { defaultPolicy } from '@metaharness/projects';

defaultPolicy();
// {
//   plannerModel: 'cheap', coderModel: 'cheap', reviewerModel: 'frontier_on_failure',
//   retrievalTopK: 12, maxRetries: 2, frontierEscalationThreshold: 0.78,
//   securityReviewRequired: true, batchEval: true, cacheRepoContext: true
// }
```

## The ten modules

| ADR | Module | Capability | Borrowed from |
|---|---|---|---|
| 157 | `checkpoints.ts` | Durable, resumable runs — resume with zero duplicate model calls | LangGraph durable execution |
| 158 | `trace.ts` | Trace format + cost ledger — every cost-unit maps to a span | OpenAI Agents SDK tracing |
| 159 | `harness-spec.ts` | Declarative, mutatable spec ⇄ genome round-trip + deterministic replay | AgentSPEX explicit graphs |
| 160 | `scheduler.ts` | Bounded loops, fail-closed, typed termination | Structured-graph scheduling |
| 161 | `memory-tiers.ts` | Five typed memory tiers + mutatable depth | CrewAI unified memory |
| 162 | `datasets.ts` | Four-split registry; a winner must win on all four | LangSmith eval workflow |
| 163 | `handoffs.ts` | Schema-contracted agent transitions | OpenAI Agents SDK handoffs |
| 164 | `safety-rails.ts` | Immutable guardrails, evaluated pre-benchmark | NeMo Guardrails |
| 165 | `opportunity.ts` | ROI-ranked automation discovery | CrewAI Discovery |
| 166 | `review-gates.ts` | Route only the uncertain edge to humans | Human-gated verification |

All built on `core.ts`: the `PolicyObject`, seeded RNG, stable hashing, the shared `TraceSpan`, and a seeded paired bootstrap.

## Design invariants

- **Dependency-free.** Node built-ins + the shared core only. No npm runtime deps.
- **Deterministic / replayable.** All randomness flows through `makeRng(seed)`; identical inputs produce byte-identical outputs. The proof of any harness change is in replay.
- **The model stays frozen.** These modules sharpen the *harness*; none of them touch or train a model.
- **Safety is not in the mutation surface.** The safety rails (ADR-164) and the policy bounds are immutable; the optimizer cannot "improve" by cheating.

## Install & build

```bash
npm install            # from the workspace root
npm run -w @metaharness/projects build
npm run -w @metaharness/projects test
npm run -w @metaharness/projects bench   # build + run every benchmark, writes bench/results/*.json
```

## Benchmarks

Each module ships a benchmark under `bench/` that writes a JSON receipt to `bench/results/`. `bench/run-all.mjs` runs them all and prints a consolidated table, and `bench/integrated.bench.mjs` runs the ADR-156 integrated acceptance scenario (a policy evolved across the modules vs a frontier-only baseline). See [Benchmarks](#measured-results) for the latest numbers.

## Measured results

Populated by `npm run -w @metaharness/projects bench`. Numbers are deterministic for the committed seeds; the source ADRs' impact figures are treated as hypotheses these benchmarks test, not guarantees.

| Module (ADR) | Benchmark headline | Receipt |
|---|---|---|
| Checkpoints (157) | **39.3%** cost saved on resume, **100%** reliability, 50% cache-hit | `checkpoints.json` |
| Trace & Ledger (158) | 24 leaks found, **50.5%** projected savings; ledger reconciles to the cent | `trace.json` |
| HarnessSpec (159) | round-trip lossless, replay deterministic across 256 seeds | `harness-spec.json` |
| Scheduler (160) | **25%** cost cut on failing tasks, **all runs terminate** (typed reason) | `scheduler.json` |
| Memory Tiers (161) | **13.6%** input tokens saved, solve rate unchanged | `memory-tiers.json` |
| Dataset Registry (162) | true winner promoted, **false winner rejected** (loses on adversarial split) | `datasets.json` |
| Typed Handoffs (163) | **66.7%** fewer retries vs free-form | `handoffs.json` |
| Safety Rails (164) | **100%** of cheating mutations rejected, **0** false rejections | `safety-rails.json` |
| Opportunity Scanner (165) | ROI-ranked portfolio, top-10 fully costed | `opportunity.json` |
| Review Gates (166) | **54.5%** fewer human reviews, **0** escaped defects | `review-gates.json` |
| **Integrated (156)** | **retries −66.7%, wasted tokens −40.7%, cost −68%, solve rate held, 0 bypasses → ALL GATES PASS** | `integrated.json` |

The integrated acceptance scenario (100 tasks × 3 repos) composes the modules into an evolved policy vs a frontier-only baseline and checks the ADR-156 targets:

| Gate | Target | Measured |
|---|---|---|
| Fewer retries | ≥ 20% | **66.7%** |
| Fewer wasted tokens | ≥ 30% | **40.7%** (memory + trace-leak pruning) |
| Cheaper than frontier-only | ≥ 50% | **68%** |
| Solve rate | same-or-better | **held** (265/265) |
| Critical guardrail bypasses | 0 | **0** |

## License

MIT © rUv
