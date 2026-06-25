# Darwin Cascade — A Cost-Pareto System for SWE-bench Lite

**51.33% (154/300) on SWE-bench Lite at $0.267 / instance.**
Wilson 95% CI [45.7, 56.9]. pass@1 (Best@1, single final prediction). Official `swebench` harness, conformant.

**Authors:** ruvnet (rUv) — `ruv@ruv.net` · https://github.com/ruvnet
**System (open source):** Metaharness / Darwin Mode — https://github.com/ruvnet/agent-harness-generator
**Live cost-Pareto leaderboard:** https://ruvnet.github.io/agent-harness-generator/cost-pareto.html

---

## TL;DR — the contribution is the *cost*, not the peak resolve

This is an **honest cost-Pareto submission, not a SOTA-resolve claim.** At 51.33% it sits mid-pack on the
absolute resolve axis (roughly top-5 among open systems on SWE-bench Lite at submission time). The contribution
is the **second axis the leaderboard does not yet rank: resolve-per-dollar.** Darwin Cascade reaches >50%
conformant resolve at **$0.267 / instance** — on the order of **56x cheaper** than frontier-only agent systems
that report comparable resolve at $15+ / instance. The thesis: most of SWE-bench Lite is solvable by a cheap
model; the expensive frontier model should be spent *surgically*, only where the cheap model provably gives up.

The mechanism that makes this work is a **deterministic, 100%-precision escalation signal: the empty patch.**

---

## 1. System overview

Darwin Cascade is a two-tier model cascade built on the open-source **Metaharness** (also called Darwin Mode),
a self-improving agent harness at `github.com/ruvnet/agent-harness-generator`.

```
                 +-----------------------------+
  instance  ---> |  Tier 1: GLM-5.2 ReAct base |  cheap interactive solver
                 |  (read / edit / run tools)  |  solves ALL 300 instances
                 +--------------+--------------+
                                |
                  patch produced?
                +---------------+---------------+
            non-empty                         EMPTY  (deterministic give-up)
                |                                 |
                v                                 v
        submit GLM patch              +-----------------------------+
                                      | Tier 2: Claude Opus 4.8     |  frontier solver
                                      | same ReAct harness          |  ONLY on empties
                                      +--------------+--------------+
                                                     v
                                          submit Opus patch (or stay empty)
```

- **Tier 1 — `glm-5.2` (z-ai):** a cheap interactive ReAct agent with `read` / `edit` / `run` tools operating on
  the repository checkout. It attempts every one of the 300 instances and emits a unified-diff patch.
- **Escalation gate — the empty patch:** if and only if Tier 1 emits an **empty patch** (no diff produced at all),
  the instance escalates to Tier 2. No test signal, no heuristic confidence score, no judge is consulted to make
  the routing decision — the gate is binary and observable from the cheap model's own output.
- **Tier 2 — `claude-opus-4.8` (anthropic):** the same ReAct harness, frontier model, run **only** on the
  escalated empty-patch instances. Its patch (if any) becomes the final prediction for that instance.

Each instance yields **exactly one** final prediction. This is **Best@1 / single-attempt** (`system.attempts: "1"`):
the cascade does not attempt an instance multiple times and then pick a winner using test knowledge — Tier 2 only
runs where Tier 1 produced *nothing*, so the two tiers never compete over the same non-empty candidate.

On this run: **187** instances were carried by GLM Tier 1 with a non-empty patch; **113** empty-patch give-ups
escalated to Opus Tier 2; **35** stayed empty even after Opus (the genuinely hardest instances, where both tiers
gave up). Final: **154 / 300 resolved, 35 no-generation, 0 missing logs.**

---

## 2. The core insight — why an empty patch is a 100%-precision escalation signal

The hard part of any cost cascade is the **gate**: you need a cheap, conformant signal that tells you *when the
cheap tier has failed*, so you can escalate only those cases and not waste frontier budget on the ones the cheap
tier already solved. The naive gates do not work, and we measured why:

- A **blind cascade** (always escalate after the cheap tier) just pays frontier cost everywhere — no savings.
- A **repo-test / regression gate** (escalate if the cheap patch fails the repo's own tests) is tempting but is a
  *regression detector, not a resolution detector*. In our measurements it fired on only ~3.7% of instances vs the
  ~34% that actually needed escalation — it proxies "did I break something," not "did I fix the bug." Worse, using
  the gold `FAIL_TO_PASS` / `PASS_TO_PASS` tests as the gate would be **non-conformant** (test-knowledge leakage).

The **empty patch is the gate that works**, for one reason: it is **ground truth about the cheap tier's outcome,
with zero false positives.** An empty patch is a patch that resolves **0%** of instances by construction — there is
no diff to apply. So escalating *exactly* the empty-patch set is a 100%-precision decision: every instance you
escalate is one the cheap tier provably could not solve, and you never escalate an instance the cheap tier already
fixed. Crucially, this signal:

1. **Requires no test knowledge** — it is read off the cheap model's own output, never from `FAIL_TO_PASS`,
   `PASS_TO_PASS`, or `hints_text`. The cascade is fully conformant.
2. **Is deterministic and observable at solve time** — no judge, no oracle, no post-hoc evaluation needed to route.
3. **Strengthens as the cheap tier's infrastructure degrades** — empty patches also arise from transient
   clone/setup failures under concurrency. Those are precisely the instances the frontier tier rescues, so a noisy
   cheap tier *increases* the cascade's lift rather than poisoning it.

This is the lever that broke the **~45% cheap-model union ceiling** we had repeatedly hit with cheap-only
ensembling: empty-patch escalation injects frontier intelligence *surgically*, only into the cells where cheap
models collectively produce nothing.

---

## 3. Results

**Headline:** 154 / 300 = **51.33%** resolved. Wilson 95% CI **[45.7, 56.9]**. Blended cost **$0.267 / instance**.

Regenerated by the official `python -m analysis.get_results` over the per-instance evaluation logs (full output in
`README.md`). Breakdown by repository:

| Repository | Resolved | Total | Rate |
|---|---|---|---|
| django/django | 71 | 114 | 62.3% |
| scikit-learn/scikit-learn | 14 | 23 | 60.9% |
| pytest-dev/pytest | 9 | 17 | 52.9% |
| astropy/astropy | 3 | 6 | 50.0% |
| matplotlib/matplotlib | 11 | 23 | 47.8% |
| sympy/sympy | 33 | 77 | 42.9% |
| pydata/xarray | 2 | 5 | 40.0% |
| pylint-dev/pylint | 2 | 6 | 33.3% |
| sphinx-doc/sphinx | 5 | 16 | 31.3% |
| mwaskom/seaborn | 4 | 4 | 100.0% |
| pallets/flask | 0 | 3 | 0.0% |
| psf/requests | 0 | 6 | 0.0% |

### The cost-Pareto frontier (measured, n=300)

| Tier | Resolve | $/instance | Wins when you value... |
|---|---|---|---|
| Economy — DeepSeek single | 34% | $0.005 | raw cheapness |
| Champion — DeepSeek Best-of-3 + judge | 39.7% | $0.015 | low budget |
| **Darwin Cascade — GLM->Opus empty-patch** | **51.33%** | **$0.267** | **resolve-per-dollar at the >50% tier** |
| Brute-force (labs) — frontier single | ~60% | $15+ | peak resolve, cost no object |

Read across the budget-weight axis `w` (how much you value resolve vs dollars): the cascade is the
**Pareto-optimal point for any operator who wants >50% conformant resolve without paying frontier-only prices.**
It is not the highest-resolve system and does not claim to be. The interactive frontier page is at
https://ruvnet.github.io/agent-harness-generator/cost-pareto.html.

---

## 4. Replication — this is not a lucky single draw

The empty-patch cascade was run **twice, independently**, at full n=300:

- **Run A (this submission):** 154 / 300 = **51.3%**, Wilson [45.7, 56.9].
- **Run B (ecascade, independent rerun of the same structure):** 152 / 300 = **50.7%**, Wilson [45.1, 56.3].

Two independent n=300 runs, 51.3% vs 50.7%, with near-fully-overlapping confidence intervals. **Pooled: 306 / 600
= 51.0%.** The result is a robust ~51% conformant frontier point, not a single fortunate sample. We also
characterized a richer two-model base (xcascade) and found it did **not** beat the simple single-base cascade at
scale (49.0% n=300) — the simple GLM->Opus cascade is the honest, reproducible recommendation.

---

## 5. Conformance guarantee

This submission satisfies every item on the SWE-bench submission checklist:

- **pass@1 / Best@1 (single attempt).** Exactly one final prediction per instance. Tier 2 runs *only* where Tier 1
  produced an empty patch, so there is never a multi-attempt bake-off resolved with test knowledge.
  `system.attempts: "1"`.
- **No SWE-bench test knowledge.** The solver never reads `PASS_TO_PASS` or `FAIL_TO_PASS`. The only tests it can
  run during solving are the repository's **own** tests in the checkout — the same tests a developer on that commit
  would have. The escalation gate is the empty patch, derived from the cheap model's output, not from any gold
  test signal.
- **No `hints_text`.** The `hints` field of SWE-bench is never read.
- **No web browsing.** The solver has **no web access** — its tools are `read` / `edit` / `run` scoped to the
  repository checkout only. It therefore cannot look up SWE-bench solutions, GitHub PRs, mirrors, or any external
  source. Conformance here is structural, not policy-based: there is simply no network/browse tool in the agent.

The full per-instance evaluation artifacts (`patch.diff`, `report.json`, `test_output.txt`) were generated by the
official SWE-bench harness and used to regenerate `results/` via `analysis/get_results.py`. They are preserved in
the open-source repo and available for verification.

---

## 6. Open source & attribution

The complete harness is open source and runnable:
**https://github.com/ruvnet/agent-harness-generator** — the Metaharness / Darwin Mode evolutionary agent harness
by **ruvnet (rUv)**. The submission package (predictions, results, logs, metadata, and this report) lives at
`submissions/swe-bench-lite/darwin-glm-opus-cascade/` in that repo.

- **First author / contact:** ruvnet (rUv) — `ruv@ruv.net` — https://github.com/ruvnet
- **System code:** https://github.com/ruvnet/agent-harness-generator (open source — `os_system: true`)
- **Models:** `glm-5.2` (open-weights base tier), `claude-opus-4.8` (closed frontier escalation tier;
  `os_model: false`).
- **Live cost-Pareto page:** https://ruvnet.github.io/agent-harness-generator/cost-pareto.html

If you take one thing from this submission: **the empty patch is a free, conformant, 100%-precision gate for cost
cascades.** It lets a cheap model carry the bulk of the benchmark and spends frontier dollars only where the cheap
model provably could not, turning a ~$15/instance frontier system into a ~$0.27/instance one at the same >50%
resolve tier.
