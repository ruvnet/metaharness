# ADR-228: GEPA-distilled executor genome — offline evolutionary optimization of the cheap executor's operating policy

**Status:** Proposed — harness built + $0-tested; GEPA pilot gated (budget + arms-finished gate, §9.5)
**Date:** 2026-07-02
**Related:** ADR-226 *(this repo — advisor-loop; the runtime-advice null this ADR answers)*, ADR-227 *(meta-llm repo — RESERVED for the completions-gateway data flywheel; see numbering note)*, ADR-194 *(this repo — crack-the-tail per-instance evolution; the Darwin frame GEPA operationalizes)*, ADR-205 *(this repo — harness handoff beats model embedding)*, ADR-201 *(this repo — H1: small models fail to use even oracle context mid-flight)*, GEPA: arXiv 2507.19457 (ICLR 2026 Oral), caution: arXiv 2603.18388 (ACL SRW 2026), `packages/darwin-mode/bench/swebench/{agentic-loop.mjs, advisor-loop.mjs, solve-advisor.mjs, gepa/}`.

> **Numbering note.** This ADR continues the cross-repo 2xx decision thread established in ADR-226 §"Numbering note": ADR-207–225 live in the meta-llm repo (`cognitum-one/meta-llm`, `docs/adr/`), ADR-226 lives here, and **ADR-227 is reserved cross-repo for meta-llm's completions-gateway data flywheel** (the trace store this ADR consumes; see §10.2). **228 is free in both repos.** Every cross-repo citation below is annotated with its repo.

---

## 0. Executive summary

ADR-226 delivered its answer today, and it is a null: a frontier advisor whispering into the cheap executor's transcript **does not move gold resolve** — arm D (deepseek-chat + Sonnet-5 advisor) scored **3/24** on the medium-24 slice, identical to the no-advisor control D0's **3/24**, while the cascade that lets the strong model **act** (B, deepseek→sonnet) scored **9/24**. Judgment delivered as a runtime observation is either ignored, evicted from the 12k-char window, or un-executable by the cheap model (ADR-201 H1 predicted exactly this).

This ADR redirects the same strong-model judgment to where it can compound: **offline, into the executor's standing operating policy**. GEPA (Genetic-Pareto, arXiv 2507.19457) is an evolutionary optimizer whose *candidate is text* — a named set of prompt/policy components — and whose mutation operator is **LLM reflection over full execution traces** (errors, logs, tool outputs), not a scalar gradient. The loop: *Fable reads many failed GLM traces → GEPA mutates the executor genome → only mutations that improve gold-scored runs survive.* This converts Fable from whispering advisor into **optimizer of the agent genome** — and it **is** the Darwin Mode thesis (ADR-194) with a principled mutation operator: reflective mutation replaces random/hand-rolled config perturbation, and GEPA's Pareto frontier ("the set of candidates which achieve the highest score on at least one evaluation instance") is exactly ADR-194's per-instance-evolution frame promoted to policy space.

Key structural fit: GEPA's candidate is a `dict[str,str]` of named text components. Our genome (§3) is designed as exactly that — **zero adapter impedance** with the reference implementation.

Deliverables: this ADR; `bench/swebench/gepa/` — genome extraction with a byte-equivalence regression guard, a genome evaluator with the pre-registered metric + rich per-instance textual feedback, a reflective-dataset builder over today's ADR-226/Fable-arm artifacts, a faithful minimal GEPA loop (mjs, documented choice §9.3), $0 mock tests; and a small, hard-gated paid pilot (§9.5).

---

## 1. Context

### 1.1 The ADR-226 result (today, gold-scored, medium-24)

All arms ran the same `solve-advisor.mjs` wiring, maxSteps 12, temp 0, `--no-test-oracle`, gold-scored via `swebench.harness.run_evaluation` (SWE-bench_Lite images). The medium slice resolved to 24 scoreable instances.

| Arm | Config | Gold resolved | Note |
|---|---|---|---|
| D0 | deepseek-chat solo (no advisor) | **3/24** | baseline control |
| D | deepseek-chat + Sonnet-5 read-only advisor | **3/24** | **= D0. The null.** |
| D-self | deepseek-chat advising itself (placebo) | 4/24 | within noise of D0/D |
| B | cascade deepseek → sonnet-5 (strong model **acts**) | **9/24** | the acting reference |
| GLM solo | z-ai/glm-5.2 solo, same loop | **7/24** | the better cheap executor |

Still landing at time of writing (fable-bench worktree, processes live): v4-pro solo, GLM+Fable-advised, v4-pro+Fable-advised. The pilot gate (§9.5) waits for them.

**Reading:** advice-at-runtime is dead on this executor (D = D0 exactly), while the *same strong model* acting in a cascade triples the baseline (9 vs 3). The strong model's judgment is real; the delivery channel — a 1.6k-char observation scrolling through a 12k-char window, executed (or not) by a model that ADR-201 H1 showed fails to use even *oracle* context 85–100% of the time — is the broken part.

### 1.2 Why offline policy evolution attacks the same gap differently

A runtime advisory competes for window space and must be executed *now* by a weak model mid-trajectory. A **policy mutation** has none of those handicaps:

- It lives in the **system prompt** — always in context, never evicted, present from step 1.
- It is **selected, not trusted**: a mutation survives only if it empirically improves gold-scored runs on the training slice. Bad advice dies in the population; bad runtime advice burns a step and pollutes the window.
- It **amortizes**: one discovered policy improvement ("stop grep loops after 2 misses; read the traceback file first") applies to every future instance at $0 marginal cost, instead of costing an advisor call per instance.

### 1.3 GEPA in one paragraph (verified citations)

GEPA — arXiv **2507.19457**, "GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning" (Agrawal, Tan, Soylu, … Khattab), **ICLR 2026 Oral** — samples system-level trajectories (reasoning, tool calls, tool outputs), reflects on them **in natural language** to diagnose problems and propose targeted text mutations, and combines lessons from a **Pareto frontier** of its own attempts: "the set of candidates which achieve the highest score on at least one evaluation instance" — per-instance-best, so candidates that win on *different task subsets* all survive, preserving diverse strategies instead of collapsing to one average winner. Paper claims: outperforms GRPO by 6% avg (up to 20%) with up to **35× fewer rollouts**; beats MIPROv2 by >10%. README-only case studies (cited as README, not paper): a coding-agent resolve lift 55%→82% (Jinja), ARC-AGI architecture discovery 32%→89%, "90× cheaper than Opus 4.1" (Databricks). The per-instance textual feedback GEPA consumes is called **ASI — "Actionable Side Information — the text-optimization analogue of a gradient"** — and it, not the scalar score, is GEPA's core advantage over scalar-only optimizers. Budget knob: `max_metric_calls` (100–500 typical, vs 5–25k GRPO rollouts). The reflection LM is separate from and deliberately stronger than the task LM.

---

## 2. Decision

Build a GEPA optimization harness over the **cheap executor's operating policy** — the genome, a named set of text components (§3) — using paired solo-fail/teacher-success traces from today's ADR-226 + Fable-arm runs as the reflective dataset, the existing `solve-advisor.mjs` D0 path as the rollout engine, gold resolve with cost/thrash penalties as the metric (§5, pre-registered), and Pareto selection over per-instance score vectors. Run 1 optimizes prompts/policies only — **no architecture search** (§6). Promotion of any evolved genome to "the executor policy" happens only through shadow + paired eval (§4 steps 11–12). The paid pilot is hard-gated (§9.5).

---

## 3. The genome — the candidate is TEXT, not weights

The genome is a flat `components: dict[str,str]` (GEPA's native candidate format — zero adapter impedance) plus non-mutable metadata. Every component maps to a concrete location in today's code:

| Genome field | Component key(s) | Where it lives today |
|---|---|---|
| **executor_prompt** | `executor_preamble`, `protocol_reminder` | `agentic-loop.mjs` `buildAgenticSystem()` — the "You are an autonomous bug-fixing agent… Tools:" preamble and the trailing "Output ONE JSON action per turn." |
| **tool_policy** (tool descriptions!) | `tool_ls`, `tool_read`, `tool_grep`, `tool_edit`, `tool_line_edit`, `tool_run_tests`, `tool_submit` | the seven tool-description lines inside `buildAgenticSystem()` (the `{"tool":…}` lines). The native-path twins in `buildAgenticToolsSchema()` descriptions are a second surface, out of scope run 1 (§6). |
| **test_policy** | `test_policy` | "Never edit test files." (the in-prompt guard; the mechanical guard in `makeTools().edit` is harness, not genome) |
| **edit_policy** | `edit_policy` | "PREFER line_edit (use the line numbers from `read`) — … If an `edit` fails to match, switch to line_edit." |
| **escalation_policy** | `tool_advise`, `escalation_policy` | `advisor-loop.mjs` `buildAdvisedSystem()` — the advise-tool line + the "fast agent with a STRONG senior ADVISOR" framing. **Empty strings in the solo (D0) seed genome.** |
| **retrieval_policy** | `retrieval_policy` | "Strategy: explore (read/grep/ls) to locate the fix, make minimal edit(s), run_tests, iterate on the trace, then submit once tests pass." |
| **verifier_prompt** | `verifier_prompt` | `advisor-loop.mjs` `buildAdvisorSystem()` — the pre-submit reviewer prompt. Empty in the solo seed; mutable in advisor-arm genomes. |

`{{ext}}` / `{{glob}}` placeholders preserve the ADR-192 polyglot templating. **Regression guard (enforced in tests):** `buildSystemFromGenome(SEED_GENOME, ext, glob)` is **byte-identical** to `buildAgenticSystem(ext, glob)` for the seed, and the advised variant is byte-identical to `buildAdvisedSystem(ext, glob)` — so genome-rendered runs are exactly today's runs until a mutation lands.

What the genome is **not**: model weights, sampling params, step budgets, or harness mechanics (window size, anti-thrash, edit validation). Those stay frozen in run 1 so every measured delta is attributable to policy text.

---

## 4. Pipeline (12 steps)

1. **Harvest paired traces**: solo-fail transcripts (cheap executor failed gold) paired with teacher-success evidence on the same instance — a Fable/Sonnet advisory log, a cascade-B success, or a D-oracle advice file (`build-reflective-dataset.mjs`). **Admitted records only** (§4.1).
2. **Build the GEPA reflective dataset**: per instance — task, cheap-trace summary, teacher trace/advice summary, outcome labels, failure class 1–6 (§5.3).
3. **Seed candidate = the extracted genome** (§3), byte-equivalent to the current policy.
4. **Evaluator runs a candidate on the training slice**: `evaluate-genome.mjs` renders the genome into the system prompt and runs the unmodified D0 path of `solve-advisor.mjs` (new additive `--genome` knob), `--no-test-oracle`, transcripts persisted.
5. **Gold-score** the run (`swebench.harness.run_evaluation`, same as every arm today).
6. **Compute the metric per instance** (§5.1) — gold-resolved dominant, cost/thrash penalties.
7. **Emit rich textual feedback (ASI) per instance** (§5.2) from the transcript + gold outcome + the paired teacher summary where one exists.
8. **Reflective mutation**: the reflection LM (Sonnet-5 for the pilot; Fable only if merited) reads the parent genome + the ASI of its worst instances and proposes a targeted TEXT mutation to one component.
9. **Pareto selection**: keep every candidate that is best on at least one instance; sample the next parent frequency-weighted by how many instances it wins.
10. **Iterate** under a hard `max_metric_calls` / dollar budget.
11. **Best candidate becomes the next executor policy — candidate only.** Report the full frontier, not one winner.
12. **Promote only through shadow + paired eval**: held-out slice, paired vs the incumbent genome, multiple repos — never from training-slice score alone (§8 mitigations).

### 4.1 Admission gates — GEPA trains ONLY on admitted records

GEPA consumes **only admitted records from ADR-227's (meta-llm) training queue** — verifier-gated: paired + verified-outcome + tests-passed + uncontaminated + provenance. Never raw traces, never unverified production output. For local benchmark artifacts (tonight's fadv/advbench runs), `build-reflective-dataset.mjs` applies the **same admission gates in the builder**: (a) *paired* — a solo-fail record must carry teacher-success evidence on the same instance; (b) *verified teacher outcome* — the teacher's success is gold-resolved (or the advice is the pre-authored, pre-registered D-oracle set), not merely claimed; (c) *contamination-scanned* — teacher advice excerpts are checked for gold-patch content not derivable from the shown transcript+diff (ADR-226 §4.8's scan), flagged records excluded; (d) *provenance* — every record names its source artifact. This makes "the pilot genome was trained only from admitted traces" a named, checkable acceptance item.

**Replay-eval convertibility bar:** every record the builder accepts must be convertible to `{tenant_id, task_signature, cheap_failed_trace, strong_success_trace, successful_patch, test_proof, retrieval_keys, replay_eligible}` — if it cannot become a replay-eval row, it is not training grade: the builder **drops it and counts it** (drop reasons itemized in the dataset header).

---

## 5. Metric + feedback (pre-registered)

### 5.1 Per-instance scalar score

```
+10.0  gold-resolved
 +1.0  targeted-tests-pass          (in-loop test signal went green)
 +0.5  minimal-patch                (≤2 non-test files AND ≤60 changed lines)
 +0.5  touched-expected-files       (patch files ∩ gold patch files ≠ ∅ — scoring-only gold use, never shown to the executor)
 −1.0  empty-patch
 −0.5  repeated-reads               (thrash > 0)
 −0.5  no-tests-run                 (no run_tests action in the transcript)
 −1.0  test-file-edits              (attempted edits to test files)
 −normalized-cost                   (instance $ / $0.50 cap, clamped to [0,1])
```

Gold-resolved dominates by construction (10 vs ≤2.0 of shaping) — the shaping terms break ties between equally-unresolved candidates and penalize thrash, not substitute for resolve.

### 5.2 Rich textual feedback per instance (ASI)

Scalar-only selection is what GEPA exists to beat. Each instance's evaluation emits prose the reflector can act on, e.g.:

> "cheap searched unrelated files 6 steps; Fable read parser.py, edited one conditional, ran test_parser_edge_case — mutation target: file localization, stop grep loops"

Generated mechanically from the transcript (steps wasted, thrash counts, files read vs files patched vs gold files, test behavior, submit/veto events) + the paired teacher summary where one exists.

### 5.3 Failure classes (reflective-dataset labels)

1 localization-failure (never read the gold files) · 2 edit-mechanics (edits attempted, failed to apply) · 3 exploration-loop (all steps read/grep/ls, empty patch) · 4 wrong-fix (right file, gold still fails) · 5 test-thrash (repeated failing run_tests without strategy change) · 6 budget-exhaustion (edits landed, ran out of steps).

---

## 6. Optimize-first order (run 1 scope)

1. v4-pro executor prompt (`executor_preamble` + `retrieval_policy`)
2. GLM executor prompt (same components, GLM genome)
3. Tool policies (the seven tool-description lines)
4. Escalation policy (advise-line + framing, advisor genomes only)
5. Verifier prompt (pre-submit reviewer)

**NO full architecture search in run 1** — no new tools, no loop-structure mutations, no step-budget changes. Text-only mutations keep every candidate runnable by the frozen harness and every delta attributable.

---

## 7. Benchmark arms + pre-registered acceptance

Arms: **baseline-A** v4-pro current genome · **baseline-B** GLM-5.2 current genome · **GEPA-A** v4-pro evolved · **GEPA-B** GLM evolved · **cascade reference** (deepseek→sonnet, 9/24 today) · **Fable-actor ceiling** (from the ADR-205 handoff line).

Live context (today, gold, medium-24): deepseek-chat solo **3/24**, **GLM-5.2 solo 7/24**, cascade(deepseek→sonnet) **9/24**; v4-pro solo + Fable-advised arms landing today.

**Acceptance (pre-registered):** a GEPA-evolved executor must score **≥ its own baseline + 3 of 24** AND capture **≥50% of the cascade lift** (cascade − baseline) AND come in at **$/resolved < cascade's**. **Minimum useful for GLM: ≥10/24** (baseline 7). Anything less is reported as a null per ADR-201's "report whichever way it lands" clause.

---

## 8. Cautions — reflective optimization degrades from defective seeds

arXiv **2603.18388**, "Reflection in the Dark: Exposing and Escaping the Black Box in Reflective Prompt Optimization" (ACL SRW 2026): under a defective seed, GEPA degrades to **13.50% on GSM8K where VISTA reaches 87.57%** — reflective mutation amplifies a bad starting policy instead of escaping it. Mitigations (all adopted, verbatim):

- holdout eval set
- keep Pareto candidates, not one winner
- require improvement across multiple repos
- canary by tenant
- rollback
- never promote from unverified traces
- compare vs cascade, not just baseline

Plus this repo's structural guard: the seed genome is byte-equivalent to the *measured* current policy (3/24, 7/24 baselines exist), so the seed is known-functional, not defective-by-construction.

---

## 9. Implementation — `bench/swebench/gepa/`

### 9.1 Files

| File | Role |
|---|---|
| `genome.mjs` | `SEED_GENOME` (extracted from `buildAgenticSystem`/`buildAdvisedSystem`/`buildAdvisorSystem`), `buildSystemFromGenome()`, `buildAdvisorSystemFromGenome()`, load/validate. Byte-equivalence regression guard in tests. |
| `metric.mjs` | `computeInstanceScore()` (§5.1), `classifyFailure()` (§5.3), `makeFeedback()` (§5.2 ASI). Pure, $0-testable. |
| `evaluate-genome.mjs` | Runs a genome on a manifest slice via `solve-advisor.mjs --genome … --advisor-model none --transcripts-dir …`, gold-scores, emits `{scores, feedbacks, cost}` per instance. |
| `build-reflective-dataset.mjs` | Harvests fadv-*-report.json advisoryLogs + transcripts (fable-bench worktree), advbench-* (adr226 worktree), gold reports → GEPA-format reflective records. |
| `gepa-loop.mjs` | The GEPA loop: `paretoFrontier()`, frequency-weighted parent sampling, reflective mutation via an injected LLM, budgeted `gepaOptimize()`. Pure + dependency-injected. |
| `run-gepa.mjs` | Real wiring: OpenRouter reflection LM + subprocess evaluator + hard $ cap + holdout scoring. |
| `*.test.mjs` | $0 mock tests: genome round-trip byte-equivalence, metric, Pareto selection, feedback generation, end-to-end loop with scripted reflector/evaluator. |

`solve-advisor.mjs` gains two **additive** knobs: `--genome <file>` (render the system prompt from a genome, D0 path) and `--transcripts-dir <dir>` (persist per-instance transcripts for feedback generation). No behavior change without the flags.

### 9.2 Language note

Bench tooling is Node mjs, matching the entire existing `bench/swebench/` harness. The repo's Rust-only rule applies to **ruOS components** (agent, services, tools, training, security) — bench harnesses are explicitly the established mjs surface here.

### 9.3 Why a minimal mjs GEPA loop instead of the `gepa` Python package (documented choice)

The reference `gepa.optimize(seed_candidate, trainset, valset, task_lm, max_metric_calls, reflection_lm)` natively takes our genome dict. But: (a) our evaluator is a Node subprocess chain (solve-advisor → Docker gold harness) and the `GEPAAdapter`'s exact `EvaluationBatch`/`ReflectiveDataset` dataclass fields were not verifiable at design time — coding an adapter blind against them violates this repo's verify-by-execution rule; (b) a Python venv is a foreign dependency in an all-mjs bench dir; (c) the algorithm we need — reflective mutation + per-instance-best Pareto selection under a metric-call budget — is ~200 lines and fully unit-testable at $0. So `gepa-loop.mjs` implements the GEPA loop faithfully (per-instance score vectors, Pareto frontier as "best on ≥1 instance", frequency-weighted parent sampling, one-component reflective text mutation, budget in metric calls **and** dollars). The genome stays a flat `dict[str,str]`, so migrating to the reference package later is a data-compatible drop-in.

**Verified reference-implementation contracts the mjs loop mirrors** (from `gepa` source, `core/adapter.py` + examples):

1. **Never raise for individual instance failures** — a failed instance returns score `0.0` + the failure text as its feedback; only systemic failures abort an iteration. (`evaluate-genome.mjs` maps per-instance errors this way, never throws mid-slice.)
2. **`sum(scores)` drives minibatch accept/reject; `mean`/per-instance vectors drive Pareto tracking** — `gepa-loop.mjs` accepts a mutation iff its train-slice score-sum beats the parent's, and maintains the frontier on per-instance bests.
3. **Candidates and batches are never mutated in place**; every mutation produces a fresh genome object.
4. **`num_metric_calls` accounting**: one genome evaluation = N instances = N metric calls, tracked against the budget (the `BudgetTracker` pattern from `examples/blackbox/utils.py`), so the $25 pilot cap maps to a metric-call cap.

One more verified reason not to route through the Python package's own runner: its `ExecutionMode.SUBPROCESS` is **Python-pickle-only** (it pickles a Python callable, not a generic binary), so a Node evaluator would need a hand-written Python `evaluate()` shelling out to `node evaluate-genome.mjs` anyway. That wrapper (Route A `GEPAAdapter`, dict-native) is the documented migration path if we later adopt the reference package; the contracts above keep our artifacts drop-in compatible with it.

### 9.4 Usage

```bash
cd packages/darwin-mode/bench/swebench

# $0 — extract + verify the seed genome (byte-equivalence guard)
node --test gepa/genome.test.mjs gepa/metric.test.mjs gepa/gepa-loop.test.mjs

# $0 — build the reflective dataset from today's artifacts
node gepa/build-reflective-dataset.mjs \
  --fable-bench ../../../.claude/worktrees/fable-bench/packages/darwin-mode/bench/swebench \
  --adr226 ../../../.claude/worktrees/agent-a41afa7de96eab8f7/packages/darwin-mode/bench/swebench \
  --out gepa/reflective-dataset.json

# paid, gated (§9.5) — evaluate one genome on a slice (Docker + API)
OPENROUTER_API_KEY=$(cat /tmp/.orkey) node gepa/evaluate-genome.mjs \
  --genome gepa/seed-genome.json --manifest advisor-medium-25.json --first 12 \
  --model z-ai/glm-5.2 --max-steps 12 --out gepa/eval-seed.json

# paid, gated (§9.5) — the pilot
OPENROUTER_API_KEY=$(cat /tmp/.orkey) node gepa/run-gepa.mjs \
  --seed gepa/seed-genome.json --model z-ai/glm-5.2 \
  --manifest advisor-medium-25.json --train-first 12 \
  --reflection-model anthropic/claude-sonnet-5 \
  --max-candidates 15 --max-cost 25 --out gepa/pilot-result.json
```

### 9.5 Pilot gate (pre-registered)

Run the pilot ONLY IF, at the moment of launch: OpenRouter headroom (key usage − $2439.31 baseline vs the $800 cap) **≥ $50** AND the 4 fadv arms (GLM/v4-pro × solo/Fable-advised) have finished. Pilot spec: GLM genome, medium-12 (first 12 of `advisor-medium-25.json`) as train, the other 12 as holdout, **budget ≤ $25 hard** (~$0.35/eval × ~15 candidates + Sonnet-5 reflection calls — not Fable), report the Pareto frontier + best-candidate **holdout** score honestly. If gated out, the harness ships ready-to-run with this command documented.

---

## 10. Relations

### 10.1 ADR-226 (this repo) — the null this answers
Same judgment source (strong model reading cheap traces), opposite delivery: runtime observation (measured dead: D 3/24 = D0 3/24) vs offline policy evolution (this ADR). ADR-226's harness is reused wholesale — `solve-advisor.mjs` is the rollout engine, its advisoryLogs are teacher traces in the reflective dataset, its D-oracle advice files are hand-written teacher summaries.

### 10.2 ADR-227 (meta-llm, reserved) — the flywheel, and the clean chain
GEPA is **the genome-evolution consumer of the same trace store** the meta-llm gateway flywheel accumulates — but only through its verifier-gated training queue (§4.1), never raw traces. Evolved genomes are also **tenant-scoped products** — "tenant-specific agent improvement without weight training first": a tenant's own failure traces evolve a tenant's own executor genome, canaried and rolled back per tenant (§8), sold as a policy artifact rather than a fine-tune.

**The clean chain (closed learning loop, no runtime advice):**

> ADR-227 (meta-llm) captures verified interventions → **ADR-228 (this) evolves executor genomes from them** → BenchPress (ADR-206, this repo) evaluates promoted genomes (probe-based, cheap) → the gateway routes to a promoted executor only after paired-eval lift.

Product positioning (verbatim): *"Cognitum records where low-cost models fail, escalates action to stronger models, verifies successful interventions, then uses those traces to improve tenant-specific execution policies over time."* — NOT "Fable teaches cheap models through advice" (that framing is the measured null of §1.1).

### 10.3 ADR-194 (this repo) — Darwin per-instance evolution
ADR-194 evolved per-instance capability genomes with hand-rolled mutation. GEPA supplies the principled mutation operator (LLM reflection over traces) and the principled selection rule (per-instance Pareto frontier — the same "different candidates win different instances" observation ADR-194's DIAGNOSIS harness made empirically).

---

## 11. Consequences

**Positive:** judgment compounds offline at $0 marginal runtime cost; every mutation is empirically selected on gold, not trusted; seed byte-equivalence means zero regression risk until a mutation is *promoted*; the genome doubles as a tenant-scoped product surface (§10.2).

**Negative:** offline evolution is slow-loop (hours of Docker rollouts per candidate generation) and slice-coupled — a genome evolved on medium-24 may overfit it (hence holdout + multi-repo promotion bars, §8); evaluator rollouts are the dominant cost and scale linearly in candidates; the ADR-226 pattern of correlated failure (ADR-225 E5/E6, meta-llm) may recur as "the reflector proposes mutations the executor cannot express."

**Neutral:** harness mechanics frozen; conformance unchanged (`--no-test-oracle` rollouts; gold used only in scoring/feedback, and `touched-expected-files` + ASI are optimizer-side artifacts that never enter any executor prompt at solve time).

---

## 12. References

- arXiv 2507.19457 — GEPA (ICLR 2026 Oral): reflective prompt evolution, Pareto frontier definition quoted in §0/§1.3, GRPO/MIPROv2 claims, 35× rollout efficiency, ASI.
- github.com/gepa-ai/gepa — `optimize` API (candidate = dict[str,str], `max_metric_calls`, separate `reflection_lm`), `optimize_anything`/`GEPAAdapter` surface, README case studies (Jinja 55→82, ARC-AGI 32→89, Databricks 90×).
- dspy.ai GEPA docs — `auto` budgets, `reflection_minibatch_size`, `candidate_selection_strategy: pareto|current_best`, merge.
- arXiv 2603.18388 — "Reflection in the Dark" (ACL SRW 2026): defective-seed degradation (GSM8K 13.50% vs VISTA 87.57%); §8's mitigation list.
- ADR-226 (this repo) — advisor-loop spec + today's D/D0/D-self/B/GLM numbers; ADR-194, ADR-205, ADR-201 (this repo); ADR-203/204/222/225/227 (meta-llm).
