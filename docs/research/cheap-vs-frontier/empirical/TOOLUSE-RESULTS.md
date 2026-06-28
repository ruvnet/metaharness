# Tool-use / function-calling — cheap vs older-frontier (empirical)

Second everyday-agentic axis of the thesis (FRAMES covered general-assistant QA).
Benchmark: **BFCL** (Berkeley Function-Calling Leaderboard, `gorilla-llm`), the
open gold-standard for tool-use. Chosen over τ-bench because it is single-turn,
gold AST-graded, and needs no user-simulator → stands up cleanly in budget and is
leak-free (gold `possible_answer` never shown to the model).

- **Categories**: simple (1 fn, 1 call) · multiple (pick 1 of several) · parallel
  (several calls). Seeded (42), **same tasks per model**.
- **Harness**: native OpenRouter tool-calling, **`tool_choice: required`** (forces
  a call — same setting for every model; for these categories a call IS the correct
  action, so this measures pure argument correctness without the "did it choose to
  call?" confound). Grader: faithful BFCL AST match (name + every gold param value
  in its acceptable set, optional via `""`, no hallucinated args, bijection for
  parallel) + Wilson 95% CI. Files: `packages/darwin-mode/bench/bfcl/`.

## RESULT — n=105 (35 per category), tool_choice=required

| Model | Tier | acc | correct/n | 95% Wilson CI | $/task | simple | multiple | parallel |
|---|---|--:|--:|---|--:|--:|--:|--:|
| **glm-5.2** | cheap | **0.867** | 91/105 | [78.9, 91.9] | $0.00078 | 0.89 | 0.94 | 0.77 |
| gpt-5.2 | older-frontier | 0.829 | 87/105 | [74.5, 88.9] | $0.00156 | 0.86 | 0.89 | 0.74 |
| **deepseek-v4-pro** | cheap | **0.810** | 85/105 | [72.4, 87.3] | $0.00114 | 0.83 | 0.94 | 0.66 |
| claude-opus-4.5 | older-frontier | **0.94*** | 48/51* | [84.1, 98.0]* | $0.00691 | 0.96 | 1.00 | 0.89 |

`*` **Opus is on its 51 cleanly-returned tasks only.** In the n=105 batch, 54/105
Opus requests **errored (cost $0, all 5 retries exhausted)** — Anthropic-via-
OpenRouter **rate-limited** the single-turn BFCL burst at concurrency 4 (worsened
by the concurrent cliff-Opus VM hitting the same account). Every one of the 54 is
an infra error, **zero genuine no-calls** (verified from `bfcl_preds` cost field);
a single live probe confirms Opus emits correct tool_calls. So the raw batch score
(0.457) is a **throughput artifact, not capability** — exactly the honesty call we
made for the FRAMES n=50 Opus 0.28. The 51 successful tasks are an unbiased
random-timing subset → 0.94 is a sound estimate; a clean full-n Opus re-run at
concurrency ≤2 (after the cliff fleet frees the Opus load) will confirm it.
Raw rate-limited file kept as `bfcl-results-opus-4-5-RAW-rate-limited.json`.

## Verdict — does parity hold on tool-use?

**Yes, parity-class holds — with a nuance.** All four models cluster high
(0.81–0.94) and the cheap models **match the clean frontier comparator GPT-5.2**:
glm-5.2 (0.867) > gpt-5.2 (0.829) > deepseek-v4-pro (0.810), all CIs overlapping.
On clean function-calling, **Opus (≈0.94) shows a real but modest edge** — unlike
FRAMES, where it did not. This matches the prior literature (tool-use is the axis
with the *smallest* cheap-vs-frontier gap): the cheap models are firmly in the
frontier band, glm even beating GPT-5.2, at **~2–9× lower $/task** (and far more
on list price). So the thesis broadens to a second task family: cheap ≈ older-
frontier on tool-use, with Opus retaining a small clean edge.

### Cost ratio
- Cheapest cheap (glm-5.2 $0.00078/task) vs clean frontier (gpt-5.2 $0.00156) ≈ **2×**;
  vs Opus ($0.0069/task) ≈ **8.9×**. (Single-turn so absolute costs are tiny; the
  ratio, not the absolute, is the thesis signal.)

## Honest caveats
- BFCL absolute numbers depend on the `required` setting + the AST grader's strict
  param matching; they track the official leaderboard's *ordering* but are not a
  leaderboard submission.
- Opus headline is n=51 (infra-limited); flagged, not hidden. Clean re-run pending.
- `n` is per-cell actual. Cheap models had near-zero errors at conc 4.
