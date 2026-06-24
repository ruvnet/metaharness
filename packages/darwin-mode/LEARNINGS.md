# What the benchmarks taught us → harness defaults

Empirical findings from the full SWE-bench Lite (300) arc (official `swebench` Docker harness,
batch-verified — see `bench/results/RESULTS.md`). These are the *measured* reasons behind the
recommended harness patterns. The headline: **the harness, not the model, is the dominant lever.**

## 1. Closed-loop repair (test feedback) is the #1 lever — ~2× for free
- open-loop single-shot: **7.7%** → + closed-loop repair (run the failing tests, feed the
  traceback back, retry ≤3): **15.3%** — on the *same cheap model*, ~$0.01/instance.
- **Recommendation:** make iteration against ground-truth (compiler/tests) first-class. A model
  that can *see why it failed* beats a smarter model that can't. Prefer `retryPolicy` configs that
  consume real failure signal over blind retries.

## 2. Localization fixes retrieval, not emission — beware the "emission wall"
- LLM file-localization lifted gold-file recall **+15pp** but resolve-rate stayed flat (8.0%).
  The bottleneck was *writing a valid patch*, not *finding the file*.
- **Recommendation:** measure where you actually lose (selection vs emission) before optimizing
  retrieval. Don't assume better context = better output.

## 3. Format contract + fit-in-context unblocks weak/local models (0 → 13/25 applied)
- A small local model emitted prose summaries instead of edits until the harness (a) served enough
  context window, (b) carried the search/replace **format contract in a system message + worked
  example**, and (c) **shrank per-file context to fit the window** (truncation silently dropped the
  instruction). Apply-rate went 0 → ~50%.
- **Recommendation:** put the output-format contract in a *system* role with an example; size the
  prompt to the model's real context; never let truncation eat the instruction.

## 4. Cheap-first + cost-aware routing — 31× cheaper per resolve
- Router probe: `pareto-code`→deepseek-v4-pro resolved at **$0.21/resolve** vs `fusion`→opus-4.8 at
  **$6.57/resolve** — same task, 31× cost gap for +1 resolve.
- **Recommendation:** default to the cheapest model that clears the task; reserve frontier models for
  measured capability gaps. Track **$/resolve**, not just resolve-rate.

## 5. Barbarian & Scholar — tier the models, escalate only the residual (up to 58.3%)
- Cheap base banks the easy wins; a frontier "Scholar" escalated **only to the residual it failed**
  cracks more; a 3rd "Sage" tier escalates again. Each tier pays only for the shrinking tail. The
  batch-verified ladder on full SWE-bench Lite (300):
  - v4-pro base + repair: 88/300 = 29.3%
  - + sonnet-4 Scholar on the tail (2-tier): 121/300 = **40.3%** [34.9, 46.0], ~$0.39/inst
  - + opus-4.8 Sage on the residual (3-tier): 175/300 = **58.3%** [52.7, 63.8], ~$0.74/inst
- **Recommendation:** N-tier cheap→frontier escalation is far more cost-efficient than one strong
  model everywhere (you'd waste most of frontier spend re-solving what cheap already gets). Returns
  diminish per tier at rising $/resolve — stop where the residual's marginal cost exceeds its value.

## 6. The repair lift is model-bound below a capability floor (~14B)
- Batch-verified on full-300: repair lifts a local 14B only **+2pp (4.7% → 6.7%** [4.4, 10.1]) — and
  108/300 of its attempts were empty/invalid diffs the model couldn't emit, so the loop had nothing to
  iterate on. The *same harness* on a hosted model reaches 29.3%. The loop needs the model to
  *occasionally* produce a correct-ish patch to converge toward; below that floor, repair recovers
  little.
- **Recommendation:** don't expect harness scaffolding to rescue a model below the task's reasoning
  floor; pick the smallest model *above* it, then let the harness multiply it.

## 7. Methodology: only batch-eval on final predictions is authoritative
- In-loop "resolved" counters drifted from clean batch eval by 1.5–5× (both directions — flaky
  passes over-count; Docker-hang false-negatives under-count). Every reported number here is a
  fresh batch eval on the final saved predictions.
- **Recommendation:** never report the in-loop signal; re-evaluate the artifact you'd actually ship.

## 8. Engineering robustness (or your run lies to you)
- Concurrency clones rate-limit (6-wide anon GitHub clones → 63 fetch failures): **cap at 2–3**,
  retry-with-backoff, free each clone. One instance (`psf__requests-2317`) reliably hangs Docker
  past timeout → known-flaky exclusion (`bench/swebench/KNOWN_FLAKY.md`). Watch for wedged containers.

---

Verdict: this paradigm (localize + search/replace + repair + tiered escalation) reaches a
batch-verified **58.3%** on SWE-bench Lite via cheap-base + 3-tier frontier escalation — 7.6× the
7.7% open-loop baseline. Both within-paradigm frontiers are now exhausted: hosted (3rd-tier escalation
at steeply rising $/resolve) and local (the §6 capability floor). The 65–88% agentic-SOTA tier needs a
**multi-step autonomous agent** (read/grep/run-tests/edit/discovery loop) — an architecture change,
not more knob-tuning. That loop is now implemented + unit-tested (ADR-153: `bench/swebench/
agentic-loop.mjs` + `solve-agentic.mjs`); its at-scale number is the next arc.

## 8. UPDATE 2026-06-22 — the 58.3% ceiling was MODEL-bound, not paradigm-exhausted

The "both within-paradigm frontiers are exhausted" verdict above was **wrong on the frontier axis**.
This weekend's arc (RESULTS §22–29) measured it:

- **Agentic loop at scale (E1–E6):** full-300 agentic v4-pro = 34.7%; + max-30 & anti-thrash = 46.3%;
  + sonnet Scholar = 50.7%; + opus-4 Sage = **55.3%** [49.7, 60.9]. The agentic 3-tier did **not** beat
  the single-shot 3-tier 58.3% — *with same-generation models*. Each tier added little because the
  agentic loop's failures **correlate** with the escalation tiers' (a shared hard tail). Agentic wins on
  **cost** (~$0.03–0.09/inst), not ceiling. This looked like a paradigm dead-end.
- **It wasn't — the Sage MODEL was the bottleneck.** Swapping Sage opus-4 → **opus-4.8** recovered
  **28/79 = 35.4%** of the residual tail opus-4 scored **0** on (identical inputs), at ~$0.65/inst
  (*cheaper* than opus-4). Folded in → **68.3%** [62.9, 73.3] (full tail), a lower bound (only 79/134 tail covered;
  full pass projects ~71%). **The ceiling moved with frontier model quality.**
- **Correct framing:** cheap-base + tiered escalation is **not** exhausted — its ceiling tracks the
  strongest available Sage model. The agentic loop is the *cost* frontier; a stronger frontier Sage is
  the *quality* frontier. They're complementary, not a fork.
- **E2 difficulty router: measured null** (5-fold CV on real labels, AUC 0.505). Resolvability is not
  predictable from scalar issue features → don't gate escalation on a learned difficulty score.
- **Process:** budget caps must live INSIDE the solver (`--max-cost`, shipped), never only in a killable
  external watchdog (a poll dying mid-run caused a ~$2.64 overage).

## 9. Two legitimate test-signal modes — the oracle is a feature, not just a leaderboard liability

The in-loop `FAIL_TO_PASS` "oracle" (gate repair/escalation on the acceptance test) is **invalid for the
leaderboard** (held-out grader) but is the **correct default for real-world use**:

- **oracle-ON (product default):** the engineer *has* the acceptance/regression test (they wrote it, or
  it's the failing CI test). "Evolve the patch until *this* test passes" is the maintainer's actual goal,
  not cheating. This is Darwin Mode's core test-driven-evolution mechanism. Measured ceiling with an
  acceptance test in hand: **68.3%** on SWE-bench Lite (RESULTS §30) — a valid *product* claim.
- **oracle-OFF (`--no-test-oracle`, conformant):** no access to the grading test; the agent writes its
  own repro (Test-Critic, ADR-174). Required for a leaderboard submission; the honest "no test given"
  number.

**Keep both as first-class options.** They answer different questions: "fix it when I give you the test"
(product, oracle-ON) vs "fix it with no test" (benchmark, oracle-OFF). Don't conflate the numbers — the
68.3% is real and useful; it just isn't a leaderboard entry. The solver flag already toggles cleanly.

## 10. The DeepSeek-V4-Flash conformant ceiling (~12-20%) — plumbing fixes don't lift reasoning; self-repro gating can Goodhart

Three gold-graded 25-instance Lite pilots, conformant (no gold oracle in-loop), DeepSeek-V4-Flash:

| config | attempt-rate | repro-validity | gold resolve [Wilson] |
|---|---|---|---|
| search floor | 44% | 68% | 5/25 = 20.0% [8.9, 39.1] |
| line-applicator | 80% | 64% | 4/25 = 16.0% |
| line + repro-gap fix (combined) | 76% | 80% | 3/25 = 12.0% [4.2, 30.0] |

**Findings:**
1. **Reasoning is the wall.** Maxing attempt-rate (line-number editing) and repro-validity (run repros as
   plain python — django/sympy testbeds lack pytest) gave NO resolve lift. The model writes applicable,
   syntactically-clean patches that are simply *wrong* on cross-file/lifecycle bugs.
2. **CIs overlap — the three are statistically indistinguishable at n=25** (~15% center). Do NOT claim
   16% or 12% as a real drop from 20%; claim only "~12-20%, no lift from plumbing."
3. **Goodhart signal (suggestive, n=25):** the combined-resolved set is a STRICT SUBSET of the floor's,
   losing 2 the floor got. More self-repro gating selected patches that pass the agent's *weak* self-test
   but fail gold — displacing lucky best-effort wins. Validates ruflo #47 empirically. A weak model
   cannot author a faithful repro, so its self-oracle is an unreliable selection target.

**Consequence:** pure-cheap conformant cannot reach top-10 (45%). The only lever is real reasoning — the
Opus-4.8 sniper (ADR-176), which can both fix the hard tail AND author a stronger repro (breaking the
Goodhart loop). The Pareto thesis survives only as a hybrid: cheap evidence-gathering + frontier sniper.

## 11. The 2×2+D ablation — the CODER binds, not the oracle; cheap-Pareto falsified

Gold-graded conformant Lite pilots, critic × coder matrix (line-applicator + repro-gap fix):

| critic ↓ / coder → | DeepSeek-V4-Flash | qwen3-coder-30b | Opus-4.8 |
|---|---|---|---|
| **DeepSeek-V4-Flash** | 12% (3/25) | **0%** (0/25) | — |
| **Opus-4.8** | **16%** (4/25) [6.4,34.7] | 4% (1/25) | **33%** (6/18) [16.3,56.3] |

Costs: Opus-critic+DS-coder = **$0.08/inst**; Opus+Opus = **$3.49/inst** (44× more).

**Findings:**
1. **Coder is the binding constraint.** DeepSeek coder caps ~12-16% *regardless of oracle*; only the
   Opus CODER reaches 33%. A strong (Opus) oracle lifts the cheap coder only 12→16% (overlapping CIs = noise).
2. **Cheap-Pareto thesis FALSIFIED.** Opus-oracle + cheap-coder (A′=16%) does NOT approach frontier (D=33%).
   The hope that a faithful contract unlocks cheap coding is wrong: DeepSeek patches pass even an Opus-
   authored repro but still fail gold — the cheap model can't *write* the cross-file fix, contract or not.
3. **qwen3-coder-30b is catastrophic in our scaffold** (0-4%) despite being leaderboard-#10 via EntroPO —
   harness-specific; does not transfer. DeepSeek is the better cheap coder.
4. **Even frontier coding caps at 33%** (D) — far below Opus's 76.8% Verified — so the SCAFFOLD (self-repro
   gating + MCTS + localization) is also a ceiling. SOTA needs frontier coding AND scaffold levers.

**Consequence:** the path to a real number is frontier *coding* where it matters (asymmetric Opus-sniper
on the cheap coder's tail — budget-viable vs Opus-on-all at ~$1000/300) PLUS scaffold levers (SBFL,
plan-then-edit, stronger gating) to lift the 33% ceiling toward the 45% top-10 bar. The "SOTA at pennies"
framing is dead; the realistic play is "competitive resolve cheaper than pure-frontier", a Pareto point
among expensive systems, not a cheap one. (n=18-25, CIs wide; coder>oracle direction + qwen-catastrophe
are clear, A′≠D point estimate is the falsification.)

## 12. The asymmetric Opus-sniper is REFUTED — single repro-gated attempts overfit the oracle

Hybrid = Opus critic + DS coder + **Opus sniper on DS-failures** (k=5 DS branches, then 1 Opus sniper).
Gold: **4/25 = 16.0%** — IDENTICAL resolved set to A′ (Opus+DS, no sniper, 16%). The sniper coded ~14
instances, drove in-loop repro-passes 7→23/25, cost $25.34 — and added **ZERO gold resolves**.

**Why:** the sniper is a SINGLE repro-gated Opus attempt. It optimizes to *pass the repro* (a narrow/
overfit patch) rather than fix the bug. Arm D (Opus **best-of-3** coding, no sniper) got 33% because 3
diverse attempts found genuinely-correct patches that converted to gold. **Best-of-k diversity, not a
single gated shot, is what makes frontier coding convert.** A high in-loop repro-pass rate (92%) with a
low gold rate (16%) is the Goodhart signature — and it's worst for single-attempt gating.

**Consequence:** the "cheap base + Opus-sniper-on-tail" cost-saver (ADR-176 L3) does NOT work — the sniper
must be best-of-k Opus *coding* to convert, which collapses back to ~Arm-D cost. The honest frontier
config is Opus best-of-3 coding (~33% @ $3.49/inst), and the remaining lever to reach 45% is the SCAFFOLD
(plan-then-edit, stronger gating), not cheaper escalation. Record: hybrid resolved ⊆ A′ resolved exactly.

## 13. BREAKTHROUGH — the stateful interactive loop ~doubles cheap-model conformant resolve (36% vs 16%)

The architecture, not the model, was the cap. Swapping MCTS+self-repro for a **stateful interactive ReAct
loop** (read/grep/ls/edit/run_tests/submit) where `run_tests` runs the **repo's OWN existing tests in
Docker** (conformant regression-guard, NO self-written proxy) — single trajectory, DeepSeek-V4-Flash:

**9/25 = 36.0% [Wilson 20.2, 55.5] @ $0.005/instance, conformant (leakage-guarded).**

vs the same cheap model under MCTS+self-repro: 12-16%. vs Opus-best-of-3 MCTS: 33% @ $3.49/inst. The
interactive loop **beats frontier-MCTS at ~700× lower cost** and resolves a broader, different set
(matplotlib/seaborn/pylint/sympy/sklearn/sphinx — incl. sympy & matplotlib MCTS never got).

**Why:** the interactive loop lets a cheap model explore like a developer (read → edit → run → see error →
fix) — maximizing its spatial reasoning — instead of forcing a blind one-shot patch gated by a flawed
self-test (the Goodhart trap of LEARNINGS §10-12). Eliminates empty-patch + format-hallucination natively.

**Caveat:** n=25, wide CI; in-loop showed 0 (existing tests = regression-guard, not fix-signal — the model
fixes from issue-understanding, submits its diff regardless). Full-300 ($0.005×300 ≈ $1.50) tightens it.
Next: full-300 single-traj → then Best-of-N (selection-without-oracle is the open problem). This reopens
the Pareto-crown path the MCTS ablation (ADR-177) had closed — supersede ADR-177's "scaffold is the
ceiling" with "the MCTS scaffold was; the interactive scaffold is not."

## 14. The selection answer (Sakana reverse-engineering, ADR-178) — LLM-judge discriminator, not a learned model

Deep-research (docs/research/SAKANA_FUGU_REVERSE_ENGINEERING.md, cited papers) cracked our Best-of-N
selection-without-gold-oracle gap:
- **"Fugu" is a multi-model orchestrator (SWE-Bench *Pro* 73.7%), NOT a SWE-bench Lite/Verified agent.** The
  real Sakana SWE system is the **Darwin-Gödel Machine (50% Verified)**, evolved from a base ~= our
  solve-agentic; its evolved wins = line-edit (have it) + **multi-attempt + a 2nd FM selecting the best**.
- **SWE-Search (ICLR 2025): an LLM Value/Discriminator that scores trajectories using the repo's EXISTING
  tests + reasoning (no gold) selects the gold-correct trajectory 73% (single value-agent) → 84% (5-agent
  debate).** Fully conformant. Top leaderboard 70%+ systems all = multi-model gen + LLM-judge selection.
- **AB-MCTS:** uses public/visible tests as the conformant reward; modest gains; doesn't map to multi-step editing.

**Decision:** the highest-leverage conformant lever is **N=3 parallel interactive ReAct trajectories + an
LLM-judge discriminator** (~$0.017/inst, ~100 lines). From our 36% single-traj base → plausibly 44-52%.
Build this FIRST (proven, no training). The Tiny-Dancer learned value-model (LEARNINGS note / +10-20 but
needs training on our trajectory→resolve labels) is the later, $0-runtime upgrade. Measure honestly:
union (oracle upper bound) vs discriminator pick vs a deterministic existing-tests baseline.

## 15. Best-of-N union = 60% ceiling; single temp-0.4 trajectory = 40-52% — interactive loop is top-10 territory

3 independent interactive trajectories (DeepSeek-V4-Flash, temp 0.4, conformant), 25-instance Lite pilot:
- **Per-set gold: 10/25 (40%), 11/25 (44%), 13/25 (52%)** — each single trajectory @ $0.005/inst is already
  top-10-competitive; set 3's 52% is top-5 territory. (Higher than the temp-0 36% pilot — sampling temp + variance.)
- **UNION (any-of-3, oracle ceiling): 15/25 = 60.0% [Wilson 40.7, 76.6]** @ ~$0.015/inst — *above* the current
  SWE-bench Lite #1 (60.33%). This is the cap any selector can reach.

**Implication:** the interactive Best-of-N approach has genuine **top-10 → near-#1** headroom at pennies. The
whole game is now the SELECTOR: capture as much of the 60% union as possible. Even capturing the *average
single set* (~45%) = top-10. The LLM-judge discriminator (env-filter + judge, LEARNINGS §14) is measuring now.
Caveat: n=25, wide CIs; full-300 single-traj (running) confirms the firm base rate. But three independent
sets at 40-52% is a strong, consistent signal — NOT a single lucky draw.

## 16. 🎯 Best-of-3 + LLM-judge discriminator = 52% conformant @ $0.015/inst (Pareto-crown signal)

The full pipeline (3 interactive trajectories temp 0.4 → Signal-A env-filter → LLM-judge), conformant,
25-instance Lite pilot:
- **DISCRIMINATOR PICK (submittable): 13/25 = 52.0% [Wilson 33.5, 70.0]** @ ~$0.015/inst.
- Captured **13 of the 15 union resolves = 87% selection efficiency** (SWE-Search reports 73-84%; ours is in range/above).
- Pipeline cost: 3×$0.005 traj + $0.0002 judge + $0 env-filter ≈ **$0.015/inst — 33× under the $0.50 Pareto target.**

This is the arc's payoff: a CONFORMANT top-10-to-top-5-territory result (≥45%) at pennies, validating the
interactive-loop + Best-of-N + judge architecture (vs the MCTS dead end, ADR-177).

**HONEST GATES (do not over-claim):** n=25, Wilson [33.5, 70.0] is too wide to assert top-10 (lower bound
33.5% < 45%), AND the temps/judge-prompt were tuned on these 25 (overfit risk). The **full-300 Best-of-3**
is required before any placement claim or submission. Running now. Only the full-300 batch number counts.

## 17. FIRM ANCHOR: interactive single-trajectory = 34.0% full-300 conformant @ $0.005/inst

Set A (DeepSeek-V4-Flash, temp 0, interactive ReAct, conformant, repo's-own-tests), official gold harness,
**full 300 SWE-bench Lite: 102/300 = 34.0% [Wilson 28.9, 39.5] @ ~$0.005/instance.** The 36% 25-pilot
(§13) held at scale — single-trajectory is the real, scale-invariant baseline (CI now tight). A standalone
cost-Pareto point: 34% conformant at half a cent/instance. Next: full-300 Best-of-3 (temp 0/0.3/0.5) +
discriminator → the >45% submittable target (union math from §15: ~60% ceiling).

## 18. MiniMax M2.5 pivot — patch quality is elite (82%) but step-budget coverage kills the score

Full experiment: 3 × 25-instance interactive ReAct trajectories, `minimax/minimax-m2.5`, temp 0.6, 15 steps,
LLM-judge discriminator (no env-filter), gold harness.

| config | coverage | accuracy/patch | gold resolved |
|---|---|---|---|
| MM25-v1 (broken parser) | 48% (12/25) | 67% (8/12) | 8/25 = 32% |
| MM25-v2 (fixed parser) | 44% (11/25) | 82% (9/11) | **9/25 = 36%** |
| DS §16 (3×BO discriminated) | ~72%+ | ~72% | 13/25 = **52%** |

**Root cause:** MiniMax M2.5 is exploration-heavy. It burns 12+ steps on `read/grep/ls` before attempting
an edit; 56% of instances exhaust the 15-step budget without producing any diff. DS-Flash edits earlier.

**Per-patch quality IS elite.** 82% of submitted patches pass the gold harness (8/11 in-loop confirmed + 2
bonus non-in-loop passes). For the 8 in-loop resolutions, avg steps to submit = 7-10. When MM25 reaches an
edit, it is correct 82% of the time — +10pp over DS (~72%). The V8-engine hypothesis holds in **quality**
but not in **step-efficiency**: DS reaches an edit faster and covers more instances in the same 15-step budget.

**parseAction fix (ADR-178 follow-on):** depth-aware JSON extraction (replaces greedy span regex) + `>>>`
transcript-echo stripping + explicit "no XML/invoke" system-prompt instruction. Lifted per-trajectory in-loop
5-6 → 7-8 (Δ+2) and the gold score 32% → 36%. The fix is model-agnostic and should stay in the harness.

**Next lever:** MM25 at 25-30 steps. At 25 steps, projected coverage jumps to 60-70% (extrapolating the
exploration pattern); 60% × 82% = 49% per trajectory; union of 3 → ~65% oracle ceiling. That would beat DS's
60% ceiling from §15 — but at ~2× the cost and time per instance. Validate with a 25-step pilot before
launching full-300.

## 18. FULL-300 Best-of-3 = 39.7% submittable / 45% union ceiling (pilot 52%/60% was small-n optimism)

Honest batch-eval correction to §15-16 (n=25 pilot). Full-300 Lite, gold, conformant, DeepSeek-V4-Flash:
- single-traj: A(temp0) 34.0%, B(0.3) 36.0%, C(0.5) 36.3% — diversity adds little per-set.
- **UNION ceiling (any-of-3): 135/300 = 45.0% [39.5, 50.7]** (pilot extrapolated 60% — small-n optimism).
- **DISCRIMINATOR (judge-only, --no-env-filter): 119/300 = 39.7% [34.3, 45.3]** @ ~$0.015/inst.
- Judge captured 119/135 = **88% of the union** even WITHOUT the env-filter (selection is efficient).

**Verdict:** Best-of-3+judge = +5.7 pts over single-traj (34→39.7) at 3× cost. Real, but the 52% pilot did
NOT hold — it used env-filter (dropped at scale for speed) + n=25 luck. Levers to recover toward the 45%
ceiling: (a) a fast/parallel env-filter (it added ~12 pts on the pilot), (b) a stronger judge (Opus). This is
the "only batch numbers authoritative; pilots drift 1.5-5×" rule — predicted ~35-40% judge-only, landed 39.7%.

## 19. Cost cascade REFUTED with the repo-test gate — gate fires 3.7% vs 34% gold (regression guard ≠ resolution detector)

ADR-182 cascade (cheap → repo-test gate → cold escalate → judge) was implemented + validated end-to-end. But
the gate signal is too weak to make it pay:
- Single-traj full-300: in-loop **gate-pass = 11/300 = 3.7%** vs **gold resolve = 102/300 = 34%**.
- The `resolvedInLoop` gate runs the changed module's EXISTING tests — it confirms "no regression", NOT "bug
  fixed" (the fix-validating test is in the gold test_patch, conformantly unseen). So it under-fires ~9×.
- 3-instance astropy cascade: 0/3 gate-pass → 3/3 escalate → judge → **$0.067/inst** (13× single-traj), no
  cheap exits. Cascade degenerates to expensive Best-of-2+judge — strictly WORSE cost-Pareto than the parallel
  Best-of-3 judge-only (39.7% @ $0.015, §18). **Cost-ranking NOT improved.** Did not run full-300 (known-negative).

**Why it matters:** any conformant early-exit/cascade needs a gate that PROXIES RESOLUTION, not regression. The
candidate: the agent's self-written reproduce_bug.py (test-critic.mjs) gated to fail-on-base/pass-on-fix — but
that re-introduces the MCTS Goodhart risk (§10), so it needs careful validation, not a blind deploy. Net: the
env-filter + LLM-judge discriminator (88% union capture, §18) remains the better conformant selector; the
cascade structure only helps if/when a strong resolution-proxy gate exists.

## 20. Judge-validated repro-gate = moderate (67% precision, 44% recall); judge counter-measure inert

ADR-183 pilot (n=25, reused patches+gold): agent self-writes reproduce_bug.py → judge validates → run-on-patch.
- reproValid (fail-on-base) 19/25 (76%, matches §13). Gate (valid∧judge∧passOnFix) fires 6/25.
- **Gate precision vs gold = 67%** (4/6 real), recall 4/9 = 44%. A real RESOLUTION signal (unlike §19's
  regression gate) but moderate + low-firing.
- **The judge counter-measure was inert**: approved 18/19 valid repros → gate 67% with OR without it. The
  repros weren't tautological enough to catch, so the Goodhart defense had nothing to do (and didn't help).
- **Does NOT beat the champion** (Best-of-3 + LLM-judge = 39.7% @ $0.015, 88% union capture, §18). The
  repro-pass is at best a FEATURE for the judge, not a standalone gate. No full run pursued.

Conclusion of the cascade/gate arc (§19-20): conformant early-exit needs a strong resolution proxy; neither the
repo regression-tests (3.7%) nor the self-repro gate (67%/44%) is strong enough to beat parallel Best-of-3.
The LLM-judge discriminator remains the best conformant selector.

## 21. Frontier ceiling probe: Opus-4.8 single = 60% (n=25) — directional, NOT a SOTA claim

GCP prove-25, claude-opus-4.8 single, interactive conformant: **60% (n=25)** vs cheap singles 40-44% (n=25).
A ~16-20pt jump confirms frontier intelligence raises *resolve* substantially — but at ~$0.50/inst (≈100× the
cheap models), so on the cost-Pareto Value Score (resolve + cheapness) Opus ranks LOW (it's the high-resolve/
high-cost top-right, not the Value winner). Implications: (a) the cheap models' ~45% union ceiling (§18) is an
intelligence bottleneck, not an orchestration one; (b) even a frontier SINGLE caps ~60% on Lite (n=25), so 80%
needs frontier ensembling (very expensive) or a strong resolution-gate cascade (§20 gate still only moderate).
n=25 — wide CI, directional only; no claim without n=300. The Value-optimal track stays a cheap model.

## 22. Cross-model Best-of-N (xbo) — orthogonality raises the union (directional, n=25)

First cross-model result, GCP prove-25, conformant: **xbo bo2 (DeepSeek-V3.2 + GLM-5.2) = 52% (n=25)** vs each
model's single **44% (n=25)** → **+8pt** from mixing two orthogonal cheap models (the §16 single-model bo3 was
+5.7pt from temperature alone). This is the first empirical support for the orthogonality hypothesis (§21 framed
the cheap-union as intelligence-bound; mixing distinct pre-training distributions widens it). Cost ≈ $0.030/inst
(v3.2 $0.012 + glm $0.018) — 2× the single-model bo3 ($0.015), so the Value verdict is w-dependent.
**Caveats:** n=25, wide CI; scale-corrected (~−6pt from the §17 calibration) lands ~46% — *promising* but NOT a
claim. The xbo TRIO (DeepSeek-V4 + GLM + Kimi) is still solving; n=300 confirmation gates any SOTA call.

## 23. xbo trio (36%) < xbo bo2 (52%) — pair the STRONGEST orthogonal models, don't maximize count

Both n=25, conformant, GCP: xbo TRIO (DeepSeek-V4 + GLM + Kimi) = **36%** vs xbo BO2 (V3.2 + GLM) = **52%** —
the trio scored *below* even its best single (v4 40%). Mechanism: the discriminator picks ONE patch per instance;
adding a weak member (Kimi single=36%) + a 3rd candidate DEGRADES judge selection faster than the wider union
helps (cf. §C: discriminator precision drops as the candidate pool dilutes). So cross-model BoN is not "more models =
more union captured" — it's **pair the two strongest orthogonal models** (V3.2+GLM, both 44% single). The bo2 is the
standout cheap-frontier candidate; dispatching its **full-300 confirmation** to test vs the 39.7% champion on Value.
(n=25 — the 16pt gap likely exceeds noise, but n=300 is the verdict.)

## 24. First cross-model-era full-300: GLM-5.2 single = 37.0% (n=300) — does NOT beat the bo3 champion

Real n=300 (local gold-eval of salvaged GCP preds, cache_level=env): **GLM-5.2 single = 111/300 = 37.0%**
[Wilson 95% CI 31.4–42.3%], cost ~$0.018/inst. vs the reigning **DeepSeek-V4 Best-of-3 = 39.7% @ $0.015**.
→ GLM single is **below the champion on resolve AND costs more** — the champion's CI (39.7%) sits inside GLM's
interval, so they're not statistically distinguishable, but GLM single has no Value case. The n=25 (44%) did NOT
hold at scale (scale-corrected ~38% predicted; 37% measured — the prediction was right, the n=25 optimism wasn't).

**Two infra bugs found + fixed this run (both produced silent under-measurement):**
1. **Eval disk-exhaustion** — `cache_level=instance` wrote 300 Docker images (~1GB ea) → 200GB disk full → most
   instances failed to build → counted unresolved (v3.2 reported a fake "14%", purged). Fix: `cache_level=env` + 300GB.
2. **113/300 empty patches** — the interactive solver produced NO patch on 38% of instances, at CONCURRENCY=4.
   The directive warns concurrency 2-3 for GitHub-clone limits; this is likely part clone-failure, part 15-step
   give-up. So 37% is a LOWER BOUND (per-attempt rate 111/187 = 59%). A concurrency-2 re-run would measure fairer —
   but GLM single is not the SOTA candidate (the xbo bo2 V3.2+GLM is), so compute goes there first.

## 25. Empty-patch → Opus escalation BREAKS 50% (pilot): blended ~55% @ $0.27 — a new high-w frontier point

The deterministic 100%-precision gate works. Pilot (n=25 of GLM's 113 give-up instances, conformant, local eval):
**Opus-4.8 resolved 12/25 = 48%** of instances where the cheap model produced an EMPTY patch (guaranteed 0%).
Opus wrote 20/25 patches ($16.58, ~$0.66/inst); 5 it couldn't patch; 12 resolved.

**Projected GLM→Opus empty-patch cascade (n=300):** blended = (111 GLM-resolved + 0.48×113 Opus-on-empties)/300
≈ **165/300 = 55.1% @ $0.267/inst** (blended 95% CI [48, 62]% — n=25 pilot noise).

Why it works (where §19 blind cascade + §20 repro-gate failed): the gate is **binary ground truth** — an empty patch is
mathematically 0%, so escalating it carries ZERO regression risk (no Goodhart trap) and spends the $0.66 Opus token
ONLY where the $0.018 model completely tapped out. It is the FIRST lever to break the ~45% cheap-union ceiling (§21,
intelligence-bound) — because it injects frontier intelligence surgically, not via orchestration.

**Cost-Pareto position (report across w):**
- Economy: DeepSeek-V4 bo3 — 39.7% @ $0.015 (champion at low w)
- **Performance: GLM→Opus empty-patch cascade — ~55% @ $0.27 (NEW; wins at high w)**
- Brute-force (labs): Opus single — ~60% @ $15+ (this cascade is ~56× cheaper for near-comparable resolve)

CAVEAT: n=25 pilot; point estimate 55% but CI lower bound 48%. Confirming with the full 113-instance escalation
(authoritative n=300 cascade, ~$58 Opus) before any firm >50% SOTA claim.

## 26. The empty-patch confound: cheap-single full-300 at concurrency-4 is severely under-measured

Recovered v3.2-single preds from the dead xbo-bo2 VM (model-0) + local gold-eval: **53/300 = 17.7%** — but with
**182/300 empty patches (61%)**. Per-attempt = 53/117 = **45%** (the real capability). The 17.7% is NOT a clean
model verdict — it's dominated by empty patches from CONCURRENCY=4 GitHub-clone failures (the directive warns
conc 2-3). Compare: glm-single (§24) had 113 empties (38%) at the same concurrency. Cheap-single full-300 numbers
at conc-4 are floors, not estimates; a conc-2 re-run is needed for a fair single number.

**Why this STRENGTHENS the empty-patch cascade (§25):** the cascade escalates ALL empties to Opus regardless of
*why* they're empty (model give-up OR infra clone-fail) — so it is robust to this confound; it mops up every 0%
instance. The worse the cheap tier's empty rate, the more the cascade rescues. The cascade converts an infra
weakness (clone-fails → empties) into escalation targets Opus resolves.

## 27. GPT-5.5 underperforms our ReAct scaffold: 28% (n=25) @ $1.25 — Opus stays the escalation tier

GCP prove-25, openai/gpt-5.5 single, interactive ReAct: **28% (n=25)** [7/25] @ ~$1.25/inst — far below Opus-4.8
single (60% n=25 @ $0.50) and even below the cheap singles (GLM/V3.2 44%). A frontier model scoring this low in our
harness points to a **scaffold/format mismatch** (GPT-5.5's tool-use/output style fits our ReAct loop worse than
Claude's) rather than raw capability — but as-measured in OUR conformant pipeline, it's both worse AND pricier than
Opus. **Implication: Opus-4.8 remains the empty-patch escalation tier of choice** (higher resolve, 2.5× cheaper).
GPT-5.5-codex (a SWE-tuned variant) might fare better and is worth a future n=25 probe; raw gpt-5.5 is not the lever.
(n=25 directional; the point is the large Opus>GPT-5.5 gap in-scaffold, not the exact %.)

## 28. ✅ CONFIRMED: GLM→Opus empty-patch cascade = 51.3% (n=300) — breaks 50%, new cost-Pareto frontier point

Authoritative full-300 gold-eval of the merged cascade (187 GLM non-empty patches + 113 Opus-escalated give-ups):
**154/300 = 51.3%** [Wilson 95% CI 45.7–56.9] @ **$0.267/inst** blended. 35 instances stayed empty (Opus also gave
up on the very hardest). The §25 pilot (projected 55%, CI 48–62) HELD at scale — the n=300 truth lands 51.3%,
lower-middle of the pilot band, decisively >50% and clear of the champion.

**The cost-Pareto frontier, measured (report across w):**
| tier | resolve (n=300) | $/inst | wins at |
|---|---|---|---|
| Economy — DeepSeek-V4 single | 34% | $0.005 | lowest w |
| Champion — DeepSeek-V4 Best-of-3+judge | 39.7% | $0.015 | low w |
| **Performance — GLM→Opus empty-patch cascade** | **51.3%** | **$0.267** | **high w (NEW)** |
| Brute-force (labs) — Opus single | ~60% (n=25) | $15+ | — |

The empty-patch gate (100%-precision: escalate only guaranteed-0% patches) is the lever that broke the ~45%
cheap-union ceiling (§18/§21) — it injects frontier intelligence surgically. At $0.267 it is ~56× cheaper than
frontier-only labs for >50% resolve. Next: xcascade (diverse cross-model base → Opus) should push higher still
by shrinking the escalation set; queued on GCP.

## 29. Sakana/DGM line_edit tool: GLM single 44% → 52% (n=25) — the empty-patch fix works (directional)

Added a `line_edit` (line-range) tool to agentic-loop alongside search/replace (SAKANA_FUGU Improvement 4; the DGM
evolved the same primitive). Search/replace needs char-for-char matches — when it fails the model often gives up →
empty patch → 0% (our measured 38-61% bottleneck, §24/§26). Editing by line number (from `read`) is robust.
**Result: GLM single n=25 = 52%** vs the 44% baseline (+8pt). n=25 caveat: that's 13 vs 11 resolved (+2 instances,
noise-compatible) — but the direction + mechanism (fewer failed-edit empties) are sound and it's a free additive
tool, so it's **kept as the default**. n=300 would confirm the magnitude; worth re-running glm full-300 with it to
see if the 113-empty rate drops. This also lifts every downstream structure (bo3/xbo/cascade) that builds on the
base solver.

## 30. 🎯 xcascade (FUGU) = 56% (n=25) — cross-model base → Opus beats the single-base cascade on BOTH axes

The composed structure (§23 cross-model diversity + §25 empty-patch escalation): xbo base (V3.2+GLM, judge-selected)
→ escalate only the patches where BOTH models gave up to Opus. **Result: 14/25 = 56% (n=25)** @ ~**$0.215/inst**
(base 25×$0.030 + Opus on **7** empties × ~$0.66). Both predictions confirmed:
- **Resolve up:** 56% > glm-cascade (51.3% n=300) / bo2 (52%) — the stronger base lifts the ceiling. 2nd only to raw Opus (60% n=25).
- **Cost down:** the cross-model base left **7 empties (28%)** vs glm-single's ~38% → fewer $0.66 Opus calls → $0.215 < $0.267.

So the Fugu architecture — *diversity for breadth, frontier escalation only where everything failed* — is the best
cheap-frontier structure found. n=25 caveat (14 vs the cascade's scaled ~13/25 — directional); **the next n=300 run
to confirm should be xcascade, not glm-cascade.** It's the new top of the cost-Pareto Performance tier.

## 31. Strong-trio xbo = 44% (n=25) — the "pair the two strongest" rule generalizes (3 models hurts even when all strong)

Tested xbo of the 3 STRONGEST singles (V3.2+GLM+DeepSeek-V4, no Kimi): **44% (n=25)** — below xbo-bo2 (V3.2+GLM,
52%) and even below the individual singles. §23 found the Kimi-trio (36%) lost to bo2; this confirms it was NOT
Kimi-specific — **adding a 3rd model degrades the judge's selection faster than the wider union helps**, regardless
of member strength. The discriminator's accuracy drops as the candidate pool grows (more ways to pick wrong). So
cross-model BoN's sweet spot is firmly **N=2, the two strongest orthogonal models**. Practical upshot: the xcascade
(§30) correctly uses a 2-model base; a 3-model base would have hurt it.

## 32. 🚀 Opus+GLM cross-model xbo = 72% (n=25) — diversity lifts the FRONTIER tier too (+12pt over Opus-single)

SOTA-push probe: xbo (cross-model Best-of-2 + judge) of **Claude-Opus-4.8 + GLM-5.2** = **18/25 = 72% (n=25)** —
vs Opus-single 60% (§21) and the cheap structures (~52-56%). The N=2 pair-strongest rule (§31) holds at the top:
Opus's raw capability + GLM's orthogonal failure modes, judge-selected, clears +12pt over Opus alone. Cost ~$0.52/inst
(Opus $0.50 + GLM $0.018 + judge) — approaching published lab SOTA (68-79%) at <1/25th the $15+ frontier-only cost.
**Caveat:** n=25 (18 vs 15 = +3 instances, noise-compatible) — directional, needs n=300 to claim. But it's the new
resolve high and confirms cross-model diversity compounds with model strength. The Performance/Brute-force tiers now
have a cheaper bridge: Opus+GLM xbo ~72%@$0.52 sits between the cascade (51.3%@$0.27) and frontier-only ($15+).

## 33. Opus bo3 = 72% (n=25) = Opus+GLM xbo — same ceiling, but cross-model is 3× cheaper

SOTA-push: Opus best-of-3 (×3 temps + judge) = **18/25 = 72% (n=25)** — IDENTICAL to Opus+GLM cross-model xbo (§32,
72%). Two takeaways:
1. **~72% is the scaffold ceiling** above Opus-single (60%) at n=25 — both "more samples + judge" routes (temp-diverse
   and cross-model-diverse) converge there. Frontier intelligence + Best-of-N selection tops out ~72% in our conformant
   ReAct harness on Lite (n=25).
2. **Cross-model xbo is the cost-efficient route:** Opus-bo3 ≈ $1.50/inst (3× Opus) vs Opus+GLM xbo ≈ $0.52/inst
   (Opus + cheap GLM). Same 72% resolve, **~3× cheaper** — because GLM ($0.018) supplies orthogonal diversity at near-zero
   marginal cost vs a 2nd/3rd Opus pass. So for any target resolve, prefer cross-model diversity over same-model temps.
Opus-bo3 is therefore DOMINATED (same resolve, higher cost) → not a frontier point; Opus+GLM xbo (72%@$0.52) is the
high-resolve anchor. n=25 caveat on both; n=300 confirm before any SOTA claim.

## 34. SWE-bench Verified: DeepSeek-V4 single = 46.4% (n=500) — first Darwin Verified number

GCP full-500 on the fixed runner (cache_level=env), official harness, conformant: **DeepSeek-V4-Flash single =
232/500 = 46.4%** @ $0.005/inst. Higher than its Lite single (34%) as expected (Verified is the human-curated
"definitely-solvable" subset → cleaner, higher base rates). First Darwin row on the Verified leaderboard tab. The
GCP full-500 eval completing cleanly also CONFIRMS the cache_level=env + 300GB disk fix works end-to-end on GCP at
n=500 (no disk-starve). Next: bo3/cascade on Verified for the cost-Pareto frontier there.

## 35b. ecascade n=300 = 50.7% — independent replication of the 51.3% cascade

A second, independent GCP run of the GLM→Opus empty-patch cascade (ecascade structure: cheap GLM solve → escalate
empty patches to Opus) = **152/300 = 50.7%** (Wilson [45.1, 56.3]). The original cascade (§28) measured 51.3%
(154/300). Two independent n=300 runs of the same structure, 50.7% vs 51.3% → CIs almost fully overlap; pooled
306/600 ≈ 51.0%. **The empty-patch cascade is a robust ~51% conformant result, not a lucky single draw.** The
leaderboard headline stays 51.3% (within noise); this is the replication that earns it confidence.
