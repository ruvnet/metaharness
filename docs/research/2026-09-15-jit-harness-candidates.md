# JIT harness candidates research note

Date: 2026-09-15

Issue: #315

ADR: ADR-315

## Primary evidence

Paper: `JIT-Agent: Scaling Harness Intelligence via Just-in-Time Harness Evolution`, arXiv:2608.25593.

Originating repository: `bingreeky/JIT`.

Repository head inspected for this note: `ababa06c2f54d799fd9fbc356e5368f61a452260`.

Repository code license: MIT. The upstream LICENSE explicitly states that benchmark data is redistributed from third parties and retains upstream licensing. No benchmark dataset should be copied into MetaHarness without separate license review.

Evidence class: originating-team paper plus public code. No RuV independent reproduction claim.

## Material claim

The paper treats the harness as a machine-generatable four-module artifact spanning memory, planning, action, and capability or tool orchestration. It reports task-dependent gains across multiple model families and benchmarks, including headline comparisons in which DeepSeek-V4-Flash with a generated harness exceeds GPT-5.6 by 9.1 points on DeepSearchQA and 4.3 points on OdysseyBench, and GLM-5.2 gains as much as 20.2 points.

These results establish a serious hypothesis that harness synthesis can be an independent capability multiplier. They do not establish that generated harnesses are safe, portable to RuV workloads, cheaper after generation cost, or superior to a tuned MetaHarness baseline.

## Strongest RuV interpretation

Do not copy the upstream runtime. MetaHarness already has generation, evaluation, Darwin evolution, flywheel promotion, replay, host adapters, security controls, and typed templates.

The reusable missing primitive is a candidate boundary: a generated task-specific harness needs a canonical, non-executable envelope before it can enter evaluation. That envelope must bind task and lineage identity, generator identity, all four module artifacts, requested capabilities, and an operator-owned capability ceiling while carrying no authority.

This keeps dynamic harness synthesis compatible with MetaHarness rather than creating a parallel orchestration runtime.

## Falsification plan

### Structural phase

Compare a naive shape-only envelope with `TaskHarnessCandidate` under capability expansion, duplicate module kinds, policy-shaped unknown fields, malformed digests, lineage mutation, and order permutations.

Reject the contract if generated content can alter the ceiling, evaluator, promotion threshold, authority source, or module completeness rules.

### Task utility phase

Independent reproduction should compare at least:

1. current static MetaHarness plan
2. static plan plus Darwin tuning
3. task-specific generated candidate without archive retrieval
4. task-specific generated candidate with prior-harness retrieval

Freeze task families, model versions, budgets, tool ceilings, prompts, evaluators, seeds, and acceptance rules before candidate results are visible.

Report task success, quality, latency, tokens, total dollar cost including generation and repair, tool calls, failure rate, repair attempts, security violations, and variance. Separate harness-generation cost from execution cost.

### Contradictions to seek

1. Gains disappear against a strong task-tuned static harness.
2. Generation cost erases execution savings.
3. Dynamic harnesses improve average reward while increasing catastrophic tail failures.
4. Archive retrieval leaks benchmark-specific solutions or creates contamination.
5. Repair loops optimize visible evaluator quirks rather than general capability.
6. Generated capability modules request broader permissions than the static baseline.
7. Improvements fail under model-family or environment transfer.

## Promotion gate

Structural validation may merge independently if it is useful as a security and interoperability primitive. No claim of JIT quality improvement should be made until an independent MetaHarness experiment shows statistically credible utility over the strongest static baseline at matched total cost and capability ceiling.

No generated harness can self-promote. RVM authorization, protected tests, security review, source provenance, independent evaluation, and human release approval remain separate gates.
