# ADR-135: Darwin Mode — the SWE-fix model frontier (the default model is suboptimal)

**Status**: Accepted (measured) — a real "optimize" finding on the model axis
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-085 (polyglot model frontier — cheap beats frontier for code), ADR-132 (multi-package corpus), ADR-130 (fitness)

## Context

> The runner (123–134) has only ever used `gemini-2.5-flash`. "Optimize" raises the obvious question the SWE arc never asked: *which model* maximizes resolve-rate per dollar on the SWE-fix task? This is ADR-085's cheap-beats-frontier check applied to `runSweBenchTask` — and it finds the current default is not the best.

## Experiment

The same 3 external-package corpus (kernel-js, create-agent-harness, vertical-base) and a fixed harness config (search/replace, maxAttempts=2, k=6) are run across four OpenRouter models; only the **model** varies. Resolve-rate and cost are measured per model. (`bench/experiments/swe-model-frontier.mjs`.)

## Decision

### Result (real, 2026-06-18)

```
model                       resolve   cost      resolve/$
deepseek/deepseek-chat      3/3       $0.0062   484      ← best (full resolve, cheapest)
openai/gpt-5-mini           3/3       $0.0109   275
anthropic/claude-haiku-4.5  3/3       $0.0303    99
google/gemini-2.5-flash     2/3       $0.0091   220      ← current default; FAILED kernel-js
```

### Findings

1. **Cheap beats frontier on SWE-fix too.** `deepseek-chat` ($0.4/Mtok) tops the frontier — full 3/3 resolve at the lowest cost (484 resolves/$), echoing ADR-085's polyglot result on a *different* task (real multi-file bug-fixing, not code-gen).
2. **The runner's default (`gemini-2.5-flash`) is suboptimal.** It resolved only **2/3** — it **failed the kernel-js rotate bug** (the hardest instance; ADR-132 already showed it needed 3 attempts there) within the 2-attempt budget, while deepseek, gpt-5-mini, and haiku each fixed it in **one** attempt. Model capability shows up as fewer attempts on harder bugs.
3. **Actionable optimization**: default the SWE runner's model to `deepseek/deepseek-chat` — strictly better than the current default here (more resolved, ~32% cheaper). gpt-5-mini is a strong second; haiku resolves all but is ~5× the cost of deepseek.

### Honest scope

- 3 instances, single-fault, in-monorepo; one config; one run per cell (LLM results not bit-reproducible). The ordering (deepseek cheapest-and-full, gemini missing kernel-js) is the signal, not the exact cents.
- gemini's miss is a 2-attempt-budget result; with more attempts it might recover (ADR-132 resolved kernel-js with gemini at 3 attempts) — but *at equal budget* the better models win, which is the point.

## Consequences

- Concrete optimization: the SWE runner should default to `deepseek-chat` (and the fitness loop of ADR-133/134 could evolve the **model** as another gene). The "model" axis is now part of the harness optimization surface, with measured evidence.
- Extends the cheap-beats-frontier thesis (ADR-085) from code-generation to real bug-fixing.

## Validation

Experiment + result committed (`bench/experiments/swe-model-frontier.mjs`, `bench/results/swe-model-frontier.json`); external package sources verified clean (temp copies). 350 tests unaffected.
