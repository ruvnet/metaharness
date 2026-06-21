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

Each module ships a benchmark under `bench/` that writes a JSON receipt to `bench/results/`. `bench/run-all.mjs` runs them all and prints a consolidated table, and `bench/integrated.bench.mjs` runs the ADR-156 integrated acceptance scenario. See [Benchmark results](#benchmark-results) for the latest numbers.

## Benchmark results

> **These are deterministic *synthetic simulations*, not empirical real-world measurements.** Each benchmark drives the module's real logic over a seeded task population so the numbers emerge from the seed (reproducible from the committed code) rather than being baked into constants — but the scenarios are constructed, and the magnitudes depend on the scenario. The source ADRs' impact figures are **hypotheses these benchmarks exercise, not guarantees**. Run with `npm run -w @metaharness/projects bench`.

| Module (ADR) | Benchmark headline (synthetic) | Receipt |
|---|---|---|
| Checkpoints (157) | **39.3%** cost saved on resume, **100%** reliability, **0** duplicate model calls on resume | `checkpoints.json` |
| Trace & Ledger (158) | 24 leaks found, **50.5%** projected savings; ledger reconciles exactly (cost-certified) | `trace.json` |
| HarnessSpec (159) | round-trip lossless, replay deterministic across 256 seeds | `harness-spec.json` |
| Scheduler (160) | both arms real runs; bounding cuts doomed-task cost (**~88%** in this seeded mix), **all runs terminate** with a typed reason | `scheduler.json` |
| Memory Tiers (161) | **13.6%** input tokens saved, solve rate unchanged | `memory-tiers.json` |
| Dataset Registry (162) | true winner promoted, **false winner rejected** (loses on adversarial split) | `datasets.json` |
| Typed Handoffs (163) | **~61%** fewer retries vs free-form (per-task free cost drawn 1–4, varies by seed) | `handoffs.json` |
| Safety Rails (164) | **100%** of cheating mutations rejected, **0** false rejections (incl. lookalike near-misses) | `safety-rails.json` |
| Opportunity Scanner (165) | ROI-ranked portfolio, top-10 fully costed | `opportunity.json` |
| Review Gates (166) | **52.5%** fewer human reviews — at a real cost of **13/200 escaped** signal-less defects (gating is not a free lunch) | `review-gates.json` |
| **Integrated (156)** | retries −58.9%, wasted tokens −42.0%, cost −64%, solve rate held, 0 bypasses, 0 false rejections → **ALL GATES PASS** | `integrated.json` |

The integrated acceptance scenario (100 tasks × 3 repos) composes the modules into an evolved policy vs a frontier-only baseline and checks the ADR-156 target gates. Each metric is driven by real module logic over the seeded population:

| Gate | Target | Result (seed 42) | How it's measured |
|---|---|---|---|
| Fewer retries | ≥ 20% | **58.9%** | real `simulateRetries`; free-form per-task cost drawn 1–4 |
| Fewer wasted tokens | ≥ 30% | **42.0%** | tiered-memory savings **+** `detectLeaks()`-computed repeated-retrieval pruning |
| Cheaper than frontier-only | ≥ 50% | **64%** | per-task cheap-vs-escalate decided by seeded difficulty (escalation count is data-driven) |
| Solve rate | same-or-better | **held** (265/265) | memory does not gate solving (no regression) |
| Critical guardrail bypasses | 0 | **0** | real rail battery over 7 cheats |
| False rejections | 0 | **0** | 2 lookalike near-misses (e.g. `policyholder.ts`) correctly allowed |

> Note on the scheduler number: the ~88% reflects a seeded population that is ~40% *doomed* tasks (which a naive unbounded loop retries ~50× while the bounded scheduler stops at 3). It is a real measurement of *this* mix, not a universal claim — change the doomed fraction and it moves.

## Real LLM measurement (optional)

Everything above is a deterministic synthetic simulation. There are **optional benchmarks that make real model calls** — `bench/handoff-llm.bench.mjs`, `bench/escalation-llm.bench.mjs`, `bench/model-bakeoff.bench.mjs`. All are gated on `OPENROUTER_API_KEY` (skip with exit 0 when absent), kept out of the deterministic suite, have hard request caps, and read the key from the environment only (never logged or committed). The client (`src/openrouter.ts`) is unit-tested with a mocked `fetch` (deterministic, no spend), and the escalation policy it informs lives in `src/router.ts` (also unit-tested without real calls).

### Cost per passing task — the metric that matters (GLM as an open-frontier lane)

The acceptance test is **cost per *passing* task**, not raw benchmark score. `escalation-llm.bench.mjs` runs a real Darwin loop (generate → verify by running the code against hidden tests in an isolated subprocess → escalate) over 10 small coding tasks; `model-bakeoff.bench.mjs` compares lanes. Real runs (single, non-deterministic; receipts `escalation-llm.json`, `model-bakeoff.json`):

| Lane | Pass | Cost / passing task |
|---|---|---|
| cheap — `qwen/qwen-2.5-7b-instruct` | 8/10 | **$0.00001** |
| open-frontier — `z-ai/glm-5.2` (1M ctx) | 8/10 | $0.00051 (**~51×**) |
| escalation (cheap → GLM on verify-fail) | 8/10 (+0 recovered) | $0.00013 |

**Honest finding:** on this (easy) task class the cheap 7B model matched GLM-5.2's pass rate, so escalation recovered nothing and the frontier lane cost ~51× more per passing task. This *confirms* the framing — GLM-5.2 is not the model you run everywhere; it's the open, MIT-licensed, 1M-context escalation lane you reserve for hard, long-horizon work where a cheap model genuinely can't reach. The task set here is too easy to exercise that; demonstrating GLM's edge needs a harder corpus (the standing real-CVE / repo-scale gap).

**A/B design (isolates one variable):** a 3-hop planner→coder→tester chain over 6 tasks. In **typed** mode the prompt names the contract's exact output fields; in **free-form** mode it just asks for "JSON". *Both* validate the output against the same schema with the real `validateHandoff()` and retry identically on failure — so the only difference is whether the contract was specified up front.

**Result** (real run, `openai/gpt-4o-mini`, 54 requests, ~$0.005 — receipt `handoff-llm.json`):

| Mode | First-try-valid hops | Retries |
|---|---|---|
| Typed (schema named) | **18 / 18** | **0** |
| Free-form (no schema) | 0 / 18 | 18 |

Naming the contract's fields up front made every handoff consumable on the first try; without it the model emitted plausible-but-non-matching field names and needed one corrective round-trip per hop (**100% retry reduction here**). Caveats, stated plainly: this is a **single, non-deterministic** run, and the effect size depends on how far the required field names diverge from the model's natural defaults — here that divergence is total, so the gap is maximal. The point it demonstrates is real: agreeing the handoff schema up front removes a real round-trip a real model otherwise spends rediscovering it.

## License

MIT © rUv
