# Retort Phase-2 — Pareto placement + ANOVA of MetaHarness vs claude-code

**What this is.** The first real, variance-attributed placement of our agentic stack
(**MetaHarness** — bounded ReAct loop + cheap↔frontier model routing) against the
**claude-code** baseline, run inside Adrian Cockcroft's **Retort** DoE/ANOVA harness
([adrianco/retort#38](https://github.com/adrianco/retort/issues/38)). Retort's own
runner, scorers, and two-opinion **conformance spec-gate judge** are reused
**untouched** — we only added a `metaharness` runner and a DoE/ANOVA methodology
layer on top, and harvested Retort's SQLite into one results frame.

**Headline.** On the genuine grid, **`metaharness/cheap` is Pareto-optimal**: it
matches frontier-model coverage (**0.954** vs claude-code/frontier's **0.958**) at
**~12× lower $/task** ($0.102 vs $1.232). It does **not dominate** the accuracy
leader (claude-code/frontier still has the highest coverage) — the two sit on
different corners of the **same** frontier (cost-optimal vs accuracy-optimal). The
cost win comes at a real **latency** cost (MetaHarness is 2–3× slower) and a real
**reliability** caveat (8/24 cheap cells timed out at the 12-min cap and are
excluded as tooling). This is *stronger* than our pre-registered expectation
("cheaper, not more accurate") on the coverage axis, but honest about the tradeoffs.

---

## The grid (validated plan, real metered run)

`harness{metaharness, claude-code} × model_tier{cheap, frontier} × language{python,
typescript, go, rust} × task{rest-api-crud, cli-data-pipeline} × 3 replicates` =
**96 runs**, executed as four Retort campaigns (one per harness × task), each over
`language × model_tier`, full factorial, 3 reps.

| factor | levels |
|---|---|
| **harness** | `metaharness` (our ReAct+routing solver) · `claude-code` (Retort `LocalRunner`, `claude` CLI) |
| **model_tier** | `cheap` · `frontier` |
| **language** | python · typescript · go · rust |
| **task** | rest-api-crud · cli-data-pipeline |

**Model mapping.** metaharness cheap = `deepseek/deepseek-v4-pro`, frontier =
`anthropic/claude-opus-4.8` (OpenRouter); claude-code cheap = `haiku`, frontier =
`opus-4.8` (`claude` CLI). The **frontier tier is model-matched** (opus-4.8) across
both harnesses, so the frontier comparison isolates the *harness* effect. The cheap
tier differs by vendor (deepseek vs haiku) — each harness's natural cheap config; the
`model×harness` interaction term picks up part of this confound (reported below).

**Scoring is Retort's, untouched.** `requirement_coverage` comes from Retort's
pinned per-task `REQUIREMENTS.json` graded by the two-opinion `evaluate-run` judge;
`code_quality` from Retort's scorer; the spec-gate decides pass/fail. Gold is used
only for scoring, never injected into the solve loop.

**Spend.** $31.10 OpenRouter this run (cap $55); research-spend $306.82 of the $375
hard-stop. claude-code + the judge run on the `claude` CLI (Anthropic subscription) =
$0 against the OpenRouter cap, but their **real metered $/task** is what's compared on
the frontier — a fair cross-stack cost comparison regardless of which provider billed.

---

## 1. Pareto frontier — the headline lens

**Requirement coverage vs $/task** (genuine cells; higher-left is better):

![Pareto frontier — coverage vs $/task](pareto-frontier.png)

```
coverage (up) vs $/task (right) — higher-left is better
0.96 |                                                         A
     |                                            B
     |C
0.45 |         D
     +----------------------------------------------------------
      $0.0679                                            $1.2317
  A = claude-code/frontier   cov=0.958  $1.232/task   FRONTIER (accuracy-optimal)
  B = metaharness/frontier   cov=0.944  $1.076/task   dominated (genuine view)
  C = metaharness/cheap      cov=0.954  $0.102/task   FRONTIER (cost-optimal)  ← our stack
  D = claude-code/cheap      cov=0.451  $0.254/task   dominated
```

| stack | n (genuine) | coverage (mean / median) | code_quality | $/task | latency | pass-rate (Wilson 95%) |
|---|---|---|---|---|---|---|
| **claude-code/frontier** | 24 | **0.958** / 1.00 | 0.749 | $1.232 | 170 s | 0.96 [0.80, 0.99] |
| **metaharness/cheap** ⭐ | 16 | **0.954** / 1.00 | 0.500 | **$0.102** | 481 s | 0.62 [0.39, 0.82] |
| metaharness/frontier | 22 | 0.944 / 1.00 | 0.687 | $1.076 | 262 s | 0.86 [0.67, 0.95] |
| claude-code/cheap | 24 | 0.451 / 0.00 | 0.775 | $0.254 | 148 s | 0.38 [0.21, 0.57] |

**Who is Pareto-optimal (coverage vs $/task):**
- **`claude-code/frontier`** — accuracy-optimal corner (highest coverage, highest cost).
- **`metaharness/cheap`** — **cost-optimal corner** (≈frontier coverage, ~12× cheaper). **Our stack is on the frontier.**
- **dominated:** `claude-code/cheap` (lower coverage *and* higher cost than metaharness/cheap), and — in the genuine view — `metaharness/frontier` (metaharness/cheap reaches the same coverage cheaper, so opus-4.8 buys MetaHarness almost nothing here).

**Is any MetaHarness stack Pareto-*dominant* (same coverage, strictly lower cost)?**
No stack dominates claude-code/frontier — it keeps the top coverage. MetaHarness/cheap
is a *different, cheaper frontier point*, not a domination. But it **does dominate the
claude-code/cheap baseline** outright (more coverage, less cost).

**Robustness to the timeout caveat (survivorship).** metaharness/cheap's 0.954 is on
the **16/24** cells that finished inside the 12-min cap (8 deepseek cells timed out →
tooling). Counting **all 24** cheap cells with the 8 timeouts scored as coverage **0**
(the conservative floor) gives metaharness/cheap = **0.636** coverage at **$0.068** —
and it is **still on the Pareto frontier** (cost-optimal corner) and **still dominates
claude-code/cheap**. So the placement is robust: the true coverage is somewhere in
[0.636, 0.954], and metaharness/cheap is Pareto-optimal at either end.

**Secondary axis — coverage vs latency.** Here the verdict flips: **both claude-code
stacks dominate**; both MetaHarness stacks are dominated. MetaHarness buys its cost
advantage with 2–3× higher wall-clock (cheap/deepseek is especially slow, 481 s mean).
The cost win is a latency trade.

---

## 2. Type-II ANOVA — variance attribution (genuine cells, n = 86)

% of variance attributed to each factor/interaction (statsmodels Type-II, log
transform; top terms shown). This **cross-checks and extends Retort's own finding**
that *the model governs reliability and the language governs quality*.

| response | top factors (% variance) | R² | residual | who governs |
|---|---|---|---|---|
| **requirement_coverage** | model **16.8** · model×harness **10.4** · language **9.8** · harness **7.7** | 0.61 | 42% | **model** (+ harness interaction) → matches Retort: *model governs reliability* |
| **code_quality** | language **19.4** · harness×language **8.3** · task **7.2** · harness **6.9** | 0.56 | 43% | **language** → matches Retort: *language governs quality* |
| **cost_per_task** | model **78.1** · harness **6.7** · model×harness **3.3** | 0.96 | 4% | **model** dominates cost |
| **latency_s** | harness **35.3** · language **15.4** · model×harness **9.5** | 0.85 | 15% | **harness** dominates latency |

**Reading it:**
- **Coverage** is governed by the **model** (16.8%), but the **harness** and the
  **model×harness interaction** together add ~18% — i.e. *which harness you wrap the
  cheap model in matters a lot at the cheap tier*. This is exactly why metaharness/cheap
  (deepseek) ≫ claude-code/cheap (haiku) on coverage: the interaction term is real.
- **Quality** is governed by the **language** (19.4%) — consistent with Retort across
  its own experiments — with a harness contribution (claude-code writes more idiomatic
  code; see §3).
- **Cost** is ~entirely the **model** (78%); the harness adds only ~7%.
- **Latency** is the **harness's** axis (35%) — MetaHarness's ReAct loop is the slow part.
- **Memory (agenticow)** was **not** a factor in this validated grid, so no variance can
  be attributed to it. It is a first-class level in the 5-factor methodology design
  (`retort_metaharness`); attributing the memory effect is the next iteration.

---

## 3. TOOLING vs GENUINE diagnosis (artifacts excluded from the frontier)

Using the `$0 / instant / zero-token failure = tooling bug` invariant
(`require_tokens=True`):

```
cells = 96   pass = 61   genuine_model_fail = 25   tooling_false_fail = 10
```

| class | n | what they are |
|---|---|---|
| PASS | 61 | spec gate met |
| GENUINE_MODEL_FAIL | 25 | the model ran (tokens>0, $>0) and fell short — kept in the ANOVA |
| **TOOLING_FALSE_FAIL** | **10** | **excluded** from frontier + ANOVA |

All 10 tooling fails are **MetaHarness 12-minute timeouts** (deepseek too slow for the
cap; zero tokens recorded): **8 in metaharness/cheap, 2 in metaharness/frontier**. They
are a genuine *harness/config* limitation (the cap, and deepseek's latency), not a model
capability failure — hence excluded from the capability comparison and reported
separately. claude-code's low cheap-coverage is **not** tooling: those cells ran
(tokens>0) and genuinely failed the spec/tests (per Retort's "tests didn't run → not a
valid success" gate) — they stay in as genuine fails.

**n per cell** = 3 replicates. Effective genuine n per stack: claude-code/frontier 24,
claude-code/cheap 24, metaharness/frontier 22, metaharness/cheap 16.

---

## 4. Per-language detail (genuine coverage)

| language | cc/cheap | cc/frontier | mh/cheap | mh/frontier |
|---|---|---|---|---|
| python | 0.667 | 1.000 | 1.000 | 1.000 |
| typescript | 0.167 | 0.833 | 0.950 | 0.926 |
| go | 0.819 | 1.000 | 0.967 | 0.983 |
| rust | 0.152 | 1.000 | 0.905 | 0.859 |

The dominated `claude-code/cheap` stack **collapses on rust (0.15) and typescript
(0.17)** — haiku writes clean-looking code (quality 0.78) that doesn't satisfy the spec
in those languages. MetaHarness/cheap (deepseek) holds 0.90–1.00 coverage across all
four languages, which is the whole reason it beats the cheap baseline and reaches the
frontier.

---

## 5. Honest verdict — where our stack places

- **MetaHarness/cheap is Pareto-optimal** — the **cost-optimal corner** of the
  coverage-vs-$/task frontier, robust to the survivorship caveat (Pareto-optimal at both
  the 0.954 genuine and 0.636 conservative coverage bounds). It **dominates the
  claude-code/cheap baseline** outright.
- **MetaHarness does not dominate the accuracy leader.** `claude-code/frontier` keeps
  the highest coverage (0.958). We place as **"≈frontier coverage at ~12× lower cost,"**
  i.e. a *cheaper frontier point*, not "more accurate" and not a clean domination — a
  slightly stronger result than our pre-registered "cheaper, not more accurate," but with
  two honest asterisks:
  1. **Latency:** MetaHarness is 2–3× slower; on coverage-vs-latency the claude-code
     stacks dominate.
  2. **Reliability:** 1/3 of cheap cells timed out at 12 min; the headline coverage is on
     the cells that finished.
- **opus-4.8 buys MetaHarness little** here: metaharness/frontier (0.944, $1.08) is
  dominated by metaharness/cheap (0.954, $0.10). The cheap deepseek tier *is* the value.
- **ANOVA agrees with Retort:** model governs reliability, language governs quality. We
  add: harness governs latency, model governs cost, and a non-trivial **model×harness
  interaction on coverage** — the cheap model's success depends heavily on the harness
  wrapped around it.

### Limitations (read before citing)
1. **12-min timeout** dropped 8/24 metaharness-cheap cells (deepseek latency). A longer
   cap would convert tooling fails into measured outcomes and tighten the cheap-tier n.
2. **Cheap-tier vendor confound** (deepseek vs haiku); the frontier tier is model-matched.
3. **No memory factor** in this grid — agenticow's effect is unmeasured here.
4. **n = 3 reps**; Wilson intervals are wide (e.g. metaharness/cheap pass-rate
   [0.39, 0.82]). More reps / a 5th would tighten them.
5. **2 tasks** (greenfield CRUD API + CLI ETL); not the harder brazil-bench.

### Next iteration (open beyond-baseline loop)
Raise the timeout (recover the 8 lost cheap cells), add the **memory** and **routing**
factors, bump to 5 reps, and add brazil-bench — to test whether MetaHarness can move
from *a cheaper frontier point* to *dominating* claude-code/frontier on a held-out split.

---

*Artifacts in this directory:* `results-combined.csv` (96 rows, per-cell), `placement-analysis.json`
(full stacks + Pareto + ANOVA + diagnosis), `pareto-frontier.png`. Reproduce via the
`retort` integration branch `metaharness-phase2` (merges the `metaharness` runner + the
`retort_metaharness` DoE/ANOVA layer) and `greenfield-solve.mjs`.
