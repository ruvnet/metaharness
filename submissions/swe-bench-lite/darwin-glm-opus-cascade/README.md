# Darwin Cascade (GLM-5.2 -> Claude Opus 4.8) — Metaharness / ruvnet

**51.33% (154/300) on SWE-bench Lite** · Wilson 95% CI [45.7, 56.9] · **$0.267 / instance** · pass@1 (Best@1) · conformant.

A **cost-Pareto** submission: the contribution is the *resolve-per-dollar* at the >50% tier (~56x cheaper than
frontier-only systems), **not** a SOTA-resolve claim. A cheap GLM-5.2 ReAct base solves all instances; **only
empty-patch give-ups** (a deterministic, 100%-precision escalation signal) are escalated to Claude Opus 4.8.

- **System (open source):** https://github.com/ruvnet/agent-harness-generator (Metaharness / Darwin Mode)
- **Technical report:** [`REPORT.md`](./REPORT.md)
- **Live cost-Pareto leaderboard:** https://ruvnet.github.io/agent-harness-generator/cost-pareto.html
- **First author:** ruvnet (rUv) — `ruv@ruv.net` — https://github.com/ruvnet

---

## Submission checklist

- [x] Is a pass@1 submission (does not attempt the same task instance more than once)
- [x] Does not use SWE-bench test knowledge (`PASS_TO_PASS`, `FAIL_TO_PASS`)
- [x] Does not use the `hints` field in SWE-bench
- [x] Does not have web-browsing OR has taken steps to prevent lookup of SWE-bench solutions via web-browsing

**pass@1 / Best@1:** Exactly one final prediction per instance (`system.attempts: "1"`). The frontier tier
(Opus 4.8) runs *only* on instances where the cheap tier (GLM-5.2) emitted an empty patch, so the two tiers never
produce competing candidates for the same instance and no test knowledge is used to select among attempts.

**Test use:** The solver never reads `PASS_TO_PASS`, `FAIL_TO_PASS`, or `hints_text`. The only tests runnable
during solving are the repository's own tests in the checkout (what a developer at that commit would have). The
escalation gate is the empty patch — derived from the cheap model's output, not from any gold test signal.

**Web browsing:** The solver has **no web access**. Its tools are `read` / `edit` / `run`, scoped to the
repository checkout only — there is no network or browser tool. It therefore cannot look up SWE-bench solutions,
GitHub PRs, mirrors, or any external source. Conformance is structural, not policy-based.

---

## `python -m analysis.get_results` output

```
Submission summary for 20260625_darwin_metaharness_glm-opus-cascade on SWE-bench lite split
==================================================
Resolved 154 instances (51.33%)
==================================================
Resolved by Repository
- astropy/astropy: 3/6 (50.0%)
- django/django: 71/114 (62.28%)
- matplotlib/matplotlib: 11/23 (47.83%)
- mwaskom/seaborn: 4/4 (100.0%)
- pallets/flask: 0/3 (0.0%)
- psf/requests: 0/6 (0.0%)
- pydata/xarray: 2/5 (40.0%)
- pylint-dev/pylint: 2/6 (33.33%)
- pytest-dev/pytest: 9/17 (52.94%)
- scikit-learn/scikit-learn: 14/23 (60.87%)
- sphinx-doc/sphinx: 5/16 (31.25%)
- sympy/sympy: 33/77 (42.86%)
==================================================
Resolved by Time
- 2012: 0/1 (0.0%)
- 2014: 0/3 (0.0%)
- 2015: 0/1 (0.0%)
- 2016: 0/4 (0.0%)
- 2017: 7/16 (43.75%)
- 2018: 10/21 (47.62%)
- 2019: 38/59 (64.41%)
- 2020: 29/66 (43.94%)
- 2021: 22/42 (52.38%)
- 2022: 31/57 (54.39%)
- 2023: 17/30 (56.67%)
```

---

## System summary

| | |
|---|---|
| **Resolve** | 51.33% (154/300), Wilson 95% CI [45.7, 56.9] |
| **Cost** | $0.267 / instance (blended) |
| **Attempts** | 1 (Best@1 / single attempt) |
| **Base tier** | `glm-5.2` (z-ai) — cheap interactive ReAct solver, all 300 instances |
| **Escalation tier** | `claude-opus-4.8` (anthropic) — only on empty-patch give-ups (113 instances) |
| **Gate** | empty patch = deterministic, 100%-precision, conformant escalation signal |
| **Harness** | Metaharness / Darwin Mode (open source) |
| **Replication** | independent rerun 50.7% (152/300); pooled 306/600 = 51.0% |

See [`REPORT.md`](./REPORT.md) for the full technical write-up: why an empty patch is a 100%-precision escalation
signal, the cost-Pareto thesis (resolve-per-dollar, ~56x cheaper at the >50% tier), the conformance guarantee, and
the independent replication.

## Cost-Pareto framing

| Tier | Resolve | $/instance |
|---|---|---|
| Economy — DeepSeek single | 34% | $0.005 |
| Champion — DeepSeek Best-of-3 + judge | 39.7% | $0.015 |
| **Darwin Cascade — GLM->Opus empty-patch** | **51.33%** | **$0.267** |
| Brute-force (labs) — frontier single | ~60% | $15+ |

The cascade is the Pareto-optimal point for >50% conformant resolve without frontier-only prices. Interactive
frontier: https://ruvnet.github.io/agent-harness-generator/cost-pareto.html

## Authors & attribution

- **First author / contact:** ruvnet (rUv) — `ruv@ruv.net` — https://github.com/ruvnet
- **Open-source system:** https://github.com/ruvnet/agent-harness-generator
- **Models:** `glm-5.2` (open weights), `claude-opus-4.8` (closed)
