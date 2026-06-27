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

## 37. Chebyshev step-depth temperature A/B (n=25): +1 instance (48% vs 44%) — weak positive, within noise

ADR-189 isolated A/B, same 25 Lite instances, GLM-5.2, conformant, official gold eval:
- **Control** (static greedy, temp 0 throughout): **11/25 = 44%**
- **Treatment** (`--cheb-temp`, hot 0.8 → greedy 0 over step depth): **12/25 = 48%**
- **Δ = +1 instance (+4%).**

Honest read: **directional-only, NOT a confirmation.** At n=25 a 1-instance delta is fully inside Wilson noise
(CIs overlap almost entirely) — it cannot distinguish +1 from 0. But two things are worth keeping:
1. **It did not hurt.** Annealing to greedy at the edit/submit steps lost nothing — the downside risk of the schedule
   is empirically ~zero, consistent with the "kill end-of-trajectory syntax hallucination" mechanism.
2. **It trended the predicted direction** (+4%, inside the hypothesized +2-5% band).

Verdict: a **weak positive that earns an n=300 confirm but not promotion to default on n=25 alone**. The n=300 cheb
run is **deferred under the spend freeze**. The schedule stays available (`--cheb-temp`, off by default). The
higher-value form of this lever is the **entropy-gated** version (ADR-189 Phase-3 / ADR-185 #2) — Chebyshev applied to
the escalation threshold, not just temperature — which should be built/tested before committing to the temperature
schedule. Net: temperature scheduling is a real-but-small lever; localization (ADR-190) remains the larger floor-lifter.

## 38. 🔑 Measured: localization is NOT our bottleneck — the ReAct agent self-localizes 7/7. ADR-190 re-graded.

Before building ADR-190's AST-mincut to fix a "50% localization miss," we measured our OWN miss rate on the 25 static-GLM
preds vs gold patches. Of 14 failures:
- **empty-patch (gave up): 7**
- **localization-miss (committed a patch but never touched the gold file): 0**
- **reasoning-miss (edited the RIGHT file, wrong fix): 7**

**Every non-empty patch we produce edits the gold file (7/7 = 100%).** The ADR-185 "BM25 misses oracle file ~50%" figure
is about **retrieve-then-generate** pipelines (Agentless feeds top-K files). Our **interactive ReAct agent localizes
itself** (grep/read/ls) and does it well — the paper's bottleneck does not transfer to our architecture. This is exactly
why we measure before building.

**Consequences (roadmap correction):**
- **ADR-190 (AST-fused mincut localization) is LOW-VALUE for us → deferred/likely-declined.** It would attack a
  bottleneck we don't have. The addressable surface is at most the 7 empty-patches, and those are *already handled* by
  the empty-patch → Opus cascade (§28).
- The real failure split is **50% empty (gave up) + 50% reasoning (right file, wrong fix)**. The empty half is solved by
  escalation (cascade/xcascade). The reasoning half is a **pure capability gap** — fixed only by a stronger model on the
  hard instance (xbo/cascade/Opus escalation), NOT by localization or retrieval.
- So the existing **cascade/xbo escalation direction is the correct lever**; the highest-value remaining work is sharper
  *escalation routing* (which instances to escalate) and *selection* among candidates — ADR-185 #2 (entropy gate) and #3
  (diverse-edit BoN), not #1 (localization). Caveat: n=25; the 7 empties are ambiguous (give-up could be reasoning- or
  search-driven) but produce no wrong-file signal. Re-measure on a larger sample when the freeze lifts.

## 36. ⚠️ opus+GLM xbo n=300 SOTA confirm FAILED to complete — Opus arm cost-capped at 63/300 (silent degradation)

The opus+GLM xbo full-300 run (the conformant SOTA shot, 72% @ n=25 §32) self-reported **38.3% (115/300)** — but this
is **NOT a valid opus+GLM xbo n=300**. The Opus arm hit the runner's **default $20 `--max-cost` cap at 63/300** and
stopped (`[max-cost] cumulative $20.23 ≥ cap $20`); the discriminator then built 300 judged preds from **opus+GLM
best-of-2 on 63 instances + GLM-alone on the other 237**. So the number is ≈ GLM-300 baseline (37%) + a +1.3pt lift
from the 63 Opus-augmented cases — dominated by glm-alone, NOT the cross-model best-of-2 the run was meant to measure.

**This number is NOT placed on the leaderboard** (it would misrepresent opus+GLM xbo). The **72% remains an n=25 result
only**; a clean opus+GLM xbo n=300 confirm needs ~300×$0.50 ≈ **$150 of Opus**, which the spend freeze forbids — so the
clean SOTA confirm is not achievable right now.

**Process lessons (baked into LOOP_WORKER):**
1. **The $20 default cost cap cannot fund an Opus-heavy full-300 arm** (~$0.35-0.50/inst → only ~57-63 instances). Any
   Opus n=300 (or opus-arm xbo n=300) run MUST set an explicit `--max-cost ≥ ~$160` or it silently produces a
   glm-dominated blend with no error.
2. **Silent degradation, not a crash:** the cap stopped one arm but the pipeline completed + self-reported a
   plausible-looking 38.3%. Always cross-check the per-arm pred counts (preds-x0 vs preds-x1) before trusting an xbo
   n=300 number — equal counts are required for a true best-of-2.
3. The cost guard *did* protect the budget (the shot cost ~$22, not ~$150) — good hygiene, wrong outcome for the goal.

## 35. xcascade (FUGU) n=300 = 49.0% — the 2-model base does NOT beat the simple cascade; n=25 56% was noise

Clean n=300 (GCP solve+escalate, GCP eval wedged → salvaged preds-merged + local gold-eval): xcascade
(V3.2+GLM xbo base → discriminator → escalate empties to Opus) = **147/300 = 49.0%** Wilson [43.4, 54.6].

**The fancier structure does not pay off.** Compare at n=300:
- GLM→Opus **cascade = 51.3%** (ecascade 50.7%, §28/§35b) — single cheap model → escalate empties.
- xcascade **= 49.0%** — TWO-model xbo base + discriminator → escalate empties.

xcascade is statistically tied-but-marginally-below the cascade (CIs overlap heavily), AND it costs more (2 base models +
a discriminator pass before the same Opus escalation). So **the cascade DOMINATES xcascade** — simpler, cheaper, ≥ resolve.
The n=25 xcascade reading (56%, §30) was small-sample optimism; at n=300 it regresses to ~49%, below the cascade. This
mirrors §36's lesson (n=25 over-promises): **the GLM→Opus empty-patch cascade (51.3%) is the confirmed cost-Pareto
Performance-tier winner; adding cross-model diversity to the *base* of an escalation cascade buys nothing at scale.**

### Confirmed n=300 frontier (SWE-bench Lite, conformant) — arc closed
ds-v4 single 34% · GLM 37% · ds-v4 bo3+judge 39.7% · xcascade 49.0% · **GLM→Opus cascade 51.3% (winner)**.
Verified: ds-v4 46.4% (n=500). opus+GLM xbo 72% is n=25-only (no clean n=300 — cost-blocked, §36).

## 39. SWE-bench Pro n=25 cascade = 4% (1/25) — the cheap-cascade thesis does NOT hold on enterprise repos

First real end-to-end SWE-bench Pro run (polyglot solver + corrected Scale eval, ADR-192). GLM→Opus cascade on the
first-25 Pro instances = **1/25 = 4%** (Wilson [0.7, 20%] — wide, n=25 directional).

**The honest story (a real finding, not just a low number):**
- **The cheap GLM base mostly FAILS on Pro: 23/25 empty patches** (vs ~30% empty on Lite). Enterprise multi-language
  repos (teleport, element-web, NodeBB, qutebrowser, ansible, openlibrary, navidrome, vuls) overwhelm the cheap tier's
  localization even with the polyglot fix (ADR-192) — the repos are large and the bugs subtle.
- All 23 empties escalated to **Opus** → the run is **Opus-dominated** → the cost-Pareto advantage that defines our Lite
  story (cheap base, surgical escalation) **collapses on Pro**: we pay ~full-Opus cost for a 4% result.
- **The cascade structure is Lite/Verified-shaped, not Pro-shaped.** Pro needs a fundamentally stronger base (or a
  Pro-specific scaffold), not cheap-base + escalation.

**Caveats (do not over-trust the 4%):** n=25, very wide CI; first-25 slice; and — the Pro eval's missing-image→score-False
fallback means some of the 24 fails could be Docker-pull/eval-infra failures rather than solver misses (the VM went
SSH-unresponsive post-eval so I could NOT verify how many of the 8 enterprise images actually pulled). So 4% is a noisy
FLOOR, possibly understated by eval-infra. **What IS validated: the Pro pipeline now runs end-to-end** (polyglot
solve → Opus escalate → real Scale `swe_bench_pro_eval` → self-report) — that plumbing is the deliverable; the resolve
number is directional and Pro is confirmed genuinely hard for this approach.

## 40. SWE-bench Pro needs a mid-tier base above the capability cliff + a long turn budget (research → ADR-192 impl)

Deep-research (10 sources, SWE-bench Pro paper arXiv:2509.16941 + Scale SEAL board) on why our cascade gave 4% (§39) and
what actually works on Pro:
- **Pro has a capability cliff at ~Sonnet-class.** Below it (GLM 9.7%, DeepSeek-V3.2 15.6%) models produce >90% empty/
  malformed patches on enterprise multi-file repos (avg 107 lines / 4.1 files changed, Go/JS/TS) — matching our GLM 23/25
  empty. **Cheap-base+empty-patch-cascade is structurally dead on Pro** (the empty cheap attempt gives the escalation
  target zero signal — you pay twice for nothing).
- **Biggest lever is `--max-steps`, not the model.** SEAL board: same Kimi K2 = 27.7% at 50 turns vs 58.6% at 250 turns
  (+31pt). Our default 15-20 steps is far too low for Pro's 4.1-file tasks.
- **The real cost-Pareto play = cheapest model ABOVE the cliff:** Kimi K2.6 (~58.6% vendor, $0.66/$3.41) is the
  resolve-per-dollar champion; then Haiku 4.5 (39.5%, ~$0.4), Gemini 3 Flash (34.6%), Sonnet 4.5 (43.6%). NOT GLM/DeepSeek.

**Implementation (this commit):** made runner `--max-steps` env-configurable (MAXSTEPS, default 15); threaded MAXSTEPS via
gcp-cluster metadata. **Config A test dispatched: Kimi K2.6 single, max-steps 60, Pro n=25.** Expected ~20-35% (vs our 4%
cascade) at ~$1/inst — a real cost-Pareto point above the cliff if it lands. Honest: this is mid-tier, not cheap-tier;
there is NO sub-$0.30 cost-Pareto play on Pro (the cliff forbids it).

## 41. ⚠️ Pro eval infra is the confound — both Pro runs = exactly 1/25; solver quality INCONCLUSIVE

Config A (Kimi K2.6 single, max-steps 60 — the §40 research's #1, expected ~20-35%) on Pro n=25 self-reported **4%
(1/25)** — IDENTICAL to the GLM→Opus cascade's 4% (§39). Two structurally different solvers returning *exactly* 1/25,
plus BOTH Pro VMs going SSH-unresponsive immediately post-eval, is strong circumstantial evidence that **the Pro eval
infrastructure — not the solver — is producing the 4% floor.** The Pro eval pulls 8 large enterprise `jefzda/sweap-images`
anonymously (Docker Hub rate limits + size) and scores any missing-image instance False (graceful fallback). If most
images fail to pull, ~24/25 score False regardless of patch quality — and "1 resolved" is plausibly just the one
instance whose image cached. I could NOT verify image-pull success (both VMs SSH-dead post-eval).

**Honest conclusion: our Pro RESOLVE numbers are not yet trustworthy.** The Config A (Kimi) test is **inconclusive on
solver quality** — eval-confounded, NOT a refutation of the §40 thesis. **Prerequisite before any Pro solver verdict:
make the Pro eval reliable** — pre-pull/cache all 8 images with Docker Hub auth (avoid anon rate limits), verify
per-instance scoring is real (not infra-False), and confirm the VM survives the eval. Until then: Pro solver comparisons
are blocked; do NOT read the 4% as "Kimi failed" or "cheap cascade = Kimi." The Lite/Verified eval path (princeton
swebench harness, cached images on ruvultra) is reliable; only the Scale-Pro path is suspect.

## 42. ✅ Pro eval FIXED + validated — the 4% was a confirmed eval-infra artifact (not the solver)

Resolved §41. Built + validated a working Pro eval: **gold patches → 5/5 (100%) resolved, empty → 0/5** (negative
control) on real Pro images. Root cause of the 4% floor CONFIRMED: Scale's `swe_bench_pro_eval.py` `eval_with_docker`
returns None on Docker-pull failure → `main()` maps None→False *silently*, and it pulls multi-GB images INSIDE each
worker thread → `--num_workers>1` fires concurrent anonymous pulls → Docker Hub rate-limit → silent-False on ~24/25 →
the 1/25 floor. Sequential pulls hit zero rate-limit. **Both Pro 4% results (cascade §39, Kimi §41) were eval artifacts,
NOT solver verdicts** — vindicating the refusal to record them as solver conclusions.
**Fix (978e1da/1384e86):** `pro-prepull-images.sh` (sequential pre-pull, retry/backoff, optional Docker Hub auth,
rate-limit-vs-not-found discrimination) + runner pre-pulls & verifies every image present before scoring → a missing
image is now a HARD ERROR, never a silent False. The real Darwin Pro resolve is now MEASURABLE; re-running Kimi K2.6
(§40 Config A) with the fixed eval to get the first trustworthy Pro number.

## 43. ✅ Abstracted HU NLHE game tree — exact CFR converges (1,116 infosets; 0.0155 → 0.0038 over 1k→10k)

Closed the gap in `crates/poker-darwin`: it had the scaling *primitives* (validated `realgames` rs_poker equity —
QQ 53.8% vs AKs 46.2%; `abstraction.rs` ruvector bucketing compressing Leduc 288→7–144) but **no NLHE game tree** to
run the exact-CFR solver on. New `src/games/holdem.rs` (`AbstractHoldem`) implements the same `Game` trait as Kuhn/
Leduc, so it plugs into `cfr.rs` and the exact `exploit.rs` best-response **unchanged**.

**The abstraction (honest scope — baked into the module doc + the `exploit` bin output):**
- **Streets:** pre-flop + flop only (2 streets; `--streets 1|2` knob). No turn/river.
- **Cards:** each hand → 1 of 6 *strength buckets* per street (higher = stronger). Throws away card-removal, suit
  texture, intra-bucket strength. The deal is a fully-specified chance measure: pre-flop bucket *marginals* (per
  player, independent) × an explicit row-stochastic *flop transition matrix* `T[pre][flop]` (stay/improve/fade
  kernel). Every chance edge carries its probability summing to 1 ⇒ `exploit.rs` integrates over the deal **exactly**,
  so exploitability is ground-truth *within the abstraction*.
- **Bets:** continuous NLHE sizing → `{fold, check/call, pot-bet, all-in}`, standard HU blinds (SB 1 / BB 2),
  20bb stacks, ≤3 raises/round to bound the tree.

**Tree size (the tractability win):** 2-street/6-bucket = **1,116 infosets**, 39,096 decision nodes, 54,648
terminals, ~94k total histories, depth 8 — comfortably under the < ~100k exact-CFR budget. 1-street = 36 infosets.

**Convergence (real measured CFR+ exploitability, exact best-response oracle):**

| iters | exploitability | game value (p0) |
|------:|---------------:|----------------:|
| 1,000 | 0.015534 | 0.191416 |
| 2,000 | 0.010006 | 0.194233 |
| 5,000 | 0.005610 | 0.196170 |
| 10,000 | 0.003769 | 0.197241 |
| 25,000 | 0.002215 | 0.198108 |

Monotone-decreasing, exactly like Kuhn/Leduc did — proof the tree, chance weighting, and showdown logic are sound.
The 1-street tree drives to < 0.01 in 5k iters. **Darwin Mode also plugs in unchanged**: on holdem (pop 6, gen 3,
150 eval-iters) the evolved champion cut exploitability **0.185 → 0.025 (86.4%)** vs the vanilla baseline, and the
best non-stationary genome beat the best static one by 55.4% — the same "dynamic > static" edge seen on Leduc.

**Honest caveat (do NOT misread):** this is the equilibrium of the **ABSTRACTION**, measured exactly within it —
**NOT** full No-Limit Hold'em (~10^160 states, intractable for any exact solver). What is **not** captured vs full
NLHE: turn + river, finer/lossless card buckets (and card-removal correlation between the two players' hands), and
full continuous bet-sizing. "Exploitability → 0 here" means "Nash of this bucketed/discretised game", never
"unexploitable at a real table". The exact-exploitability oracle is the runtime bottleneck (each call walks the full
~94k-history tree twice), so the largest comfortably-exact size is the 2-street/6-bucket default; pushing buckets or
adding the turn grows the tree super-linearly and would need MCCFR sampling rather than exact CFR.

**Measured runtime / largest tractable size:** the bottleneck is the exact best-response pass, not the CFR train.
A full 25,000-iter CFR+ train **plus** the final exact two-sided best-response over the ~94k-history tree took **608 s
(~10 min)** wall on ruvultra; 100k therefore runs ~40+ min and was killed as impractical for the doc loop (no value
beyond the already-monotone curve). **So the largest comfortably-exact configuration is the 2-street / 6-bucket
default (1,116 infosets).** Beyond it — more buckets, the turn/river — exact CFR is too slow and the crate would need
the MCCFR sampling path; the exact oracle stays the gold standard only at this abstraction size.
## 44. Reproduction-test SELECTION (ADR-193) = +1 (52% vs 48%, n=25) — but the lift is NOT the repro signal, and the union ceiling is the real wall

The conformant, Goodhart-free analog of Test-Driven Repair: keep N candidates **independent** of the repro test
(no candidate optimizes against it → no self-grading trap of §10/ADR-174), then SELECT among them by which one makes
a **model-written** `reproduce_bug.py` pass. Built `repro-select.mjs` (selector), `repro-select-eval.mjs` (gold
scoring), `repro-select-ab.mjs` (A/B). Clean A/B on the **same** first-25 Lite, cheap base (deepseek-v4-flash bo3 at
temps 0.2/0.5/0.8, `--no-test-oracle` so candidates never saw gold either), official `swebench` 4.1.0 gold eval:

| selector (same 3 candidate sets) | resolve | Wilson 95% |
|---|---:|---|
| **bo3 + LLM judge (baseline, discriminator.mjs)** | **12/25 = 48%** | [30.0, 66.5] |
| **bo3 + repro-test select (repro-select.mjs)** | **13/25 = 52%** | [33.5, 70.0] |
| oracle union (any-of-3 candidates) | 13/25 = 52% | [33.5, 70.0] |
| Δ (repro − baseline) | **+1 instance (+4%)** | inside n=25 noise |

**Why this is a NEGATIVE-leaning result despite the +1 (the honest read):**
1. **The +1 is an artifact, not the repro signal.** The one gained instance (`django-10924`) was a
   `judge-fallback-norepro` case — *no* candidate passed the repro, so repro-select fell back to the plain judge.
   It resolved only because the two selectors **index the candidate pool differently** in the fallback path
   (discriminator's env-filter reorders/dedups; repro-select keeps original set order) and happened to land on the
   good patch (set#1, 603-byte) where the baseline judge picked set#0 (1040-byte, wrong). Pure plumbing luck.
2. **The repro signal changed selection on exactly 1/18 multi-candidate instances** (astropy-14995) — and there both
   the repro pick and the baseline pick already resolved, so the change was net-zero. `changedSelectionVsJudge = 1/18`.
3. **The limiter the task predicted is real and dominant: `reproPassedSomeCandidate = 3/18`.** Even when the repro
   test is valid (15/25 = 60% FAIL-on-base, matching §13/§20's ~76%), a *candidate* almost never makes it PASS —
   the weak cheap candidates rarely fix the bug well enough to flip a self-written test. So the selector has nothing
   to select on for 15/18 multi-candidate instances and degenerates to the baseline judge (`judge-fallback-norepro`
   12×, `judge-fallback-invalid` 3×).
4. **The real wall is the candidate UNION (52%), not selection.** Baseline already captures 12/13 = 92% of the union;
   repro-select 13/13 = 100%. With only a 4-pt gap between baseline and the oracle ceiling, **no** selector can lift
   much — the bottleneck is candidate *generation* (cheap-model capability, §21/§38 "reasoning-miss"), not the picker.

**Conformance held (asserted, not asserted-on-faith):** the `first25.json` manifest carries **zero** gold fields
(`test_patch`/`FAIL_TO_PASS`/`PASS_TO_PASS` literally absent), the repro test is built from `problem_statement` only,
`conformant-tests.mjs` stages only `candidate + reproduce_bug.py` into the BASE image and never applies the gold
test_patch, and `repro-select.mjs`'s `assertConformant` guard threw **0** violations across the run. Gold tests touch
the pipeline ONLY in the final `swebench` scoring — same as every other Darwin run.

**Honest ceiling note (matches the prediction):** a self-written repro can be wrong/weak and you can't verify it
without the gold test. Here it reproduced 60% of the time but a candidate *passed* it only 3/18 times — so it bought
a *partial* lift toward TDR's 68.3% only on paper; in practice the lift was 0 once you discount the indexing artifact.
**Verdict: repro-test SELECTION does not beat bo3+judge on cheap candidates** — same conclusion as the §19-20 gate
arc, reached from the selection side. It would only matter if (a) candidates were strong enough to often pass a
self-written test, and (b) the candidate union were well above the judge's capture rate. Neither holds for the cheap
base. Cost was trivial ($0.018 writer+judge LLM; Docker repro/regression runs dominate wall-clock, ~5-9 exec rounds/
instance). Scoped to `bench/swebench/` (`repro-select*.mjs`); not promoted to default. n=25 — directional only.

## 45. Pro Kimi K2.6 (FIXED eval) = 1/25 (4%) — turn-budget cliff CONFIRMED; cheap Pro is dead

The re-run with the §42-validated eval (`darwin-pro-kimi-k2-6`, Kimi K2.6, max-steps 60) **completed, self-reported
1/25 = 4%** (Wilson 95% CI [0.7%, 19.5%]), then AUTOSTOPPED (the halt fires 2 min *after* self-report, not on timeout —
so the run finished). Because the fixed eval **FAILS LOUD on a missing image** (§42: a reported score ⟹ images present ⟹
eval ran correctly), this is a **real eval verdict, NOT the prior silent-False artifact**.

**The decisive tell:** Pro has returned **exactly 1/25 three independent times** — cascade (§39, broken eval), Kimi
(§41, broken eval), Kimi (now, FIXED eval). The eval changed from broken→validated; the number did not. That rules out
"recurring artifact" and points to a consistent reality: **~1 trivially-solvable Pro instance + 24 enterprise repos that
60-step agentic solving cannot crack.**

This **confirms the §40 turn-budget cliff**: Kimi's vendor **58.6%** (250-turn scaffold) collapses to **~4%** at our
60-step harness on enterprise repos. **Conclusion — a cheap cost-Pareto play on Pro is structurally dead:** Pro resolve
requires the expensive ~250-turn budget (the §40 lever), which is off our resolve-per-dollar thesis. The Pro arc is now
*closed and explained*: the eval is correct (§42, gold→5/5), the model is capable (Kimi vendor 58.6%), the blocker is
fundamentally **turn-budget × enterprise-repo difficulty** — not eval, not model choice.

Honest caveats: the VM terminated before I could inspect its eval log directly; the fail-loud design + the
recurring-exactly-1/25 consistency are the basis for treating 4% as real. n=25 CI is enormous — directional, not precise.

## 46. LiveCodeBench — single-shot deepseek = 16/25 (64%); TDR repair gives NO lift (public-test overfits)

First real measurement on a *contamination-resistant* code-generation benchmark (LiveCodeBench, the contest-recency
analogue of SWE-bench). Validated end-to-end against the OFFICIAL `lcb_runner` harness; scoped to `bench/livecodebench/`.

**The eval-validation gate (the §42 lesson, applied first — before trusting any number).** Before scoring the run, fed
the official `codegen_metrics` scorer (via a thin question_id-subset wrapper around `custom_evaluator`, scorer untouched)
a KNOWN-CORRECT solution and a known-empty/wrong one:
- known-correct (1 stdin AtCoder + 1 functional LeetCode) → **PASS, pass@1 = 1.0** ✓
- empty + deliberately-wrong → **FAIL, pass@1 = 0.0** ✓
Both I/O modes (stdin and functional) discriminate correctly, so a real score is trustworthy. (This is exactly why the
Pro number was garbage for days in §42 — never trust a pass-rate from an eval you haven't proven can score a correct
solution as passing.)

**Dataset (contamination knob honoured).** Balanced n=25 subset of release_v5's **≥2024-12-01** window (Dec 2024–Jan 2025
contests) — *after* deepseek-chat's training cutoff, the whole point of LCB's recency design. Mix: 13 AtCoder / 12
LeetCode, easy 9 / medium 8 / hard 8, stdin 13 / functional 12.

**Single-shot result (the leaderboard-comparable baseline):** **16/25 = 64.0%**, Wilson 95% CI **[44.5%, 79.8%]**,
**$0.0307 total / $0.00123 per problem / $0.0019 per solved**. By difficulty: **easy 8/9, medium 6/8, hard 2/8** — the
expected gradient (cheap model cracks easy/med, struggles on hard). 2 of the 9 misses were **empty extractions**: on two
hard problems deepseek emitted a long reasoning preamble and the final code wasn't in the last fenced block, so the
extractor (byte-identical to the official `extract_code`, last ```...``` pair) grabbed prose — a *model-formatting*
failure the official leaderboard scores the same way, not an eval bug.

**TDR-style verify-and-repair arm (the test-is-the-verifier hypothesis): NO lift.** Ran candidate → public sample tests
in a throwaway `python3` subprocess (private tests gold-held, leakage-free) → 1 repair attempt on failure. Result:
**still 16/25 = 64%.** The deltas tell the story: only stdin/AtCoder problems get repair signal (LeetCode functional
tests aren't safely runnable without a harness), 3 triggered repair, and **abc384_g went PASS→FAIL** — the repair made
it pass the *visible* sample but **regressed on the hidden tests** (classic overfit-the-visible-test). The one net +1
(3634) was an unrelated temp-0 nondeterminism flip, not from repair. **Verdict: public-sample-only feedback does NOT
lift cheap candidates on LCB** — passing the one visible example ≠ passing the hidden suite, and can actively regress.
This is the §44 conclusion reached from a different benchmark: a weak/partial verifier doesn't beat the base.

**Contamination caveat (honest).** The window is post-cutoff so it's *contamination-resistant by construction*, but (a)
"deepseek-chat" on OpenRouter is a moving snapshot (V3.x) whose exact training cutoff isn't pinned, so I can't *prove*
zero overlap — only that the window is later than the disclosed cutoff; (b) n=25 is a **directional** sample with a wide
CI and is **easy/medium-skewed**, so the 64% is NOT 1:1 comparable to the official whole-release_v5 leaderboard (DeepSeek-V3
~34% on the harder, larger full set). Both facts are flagged on the board's `livecodebench` tab. n=25 — directional, not precise.

## 47. ✅ Verified-500 cascade = 55.6% (278/500) — the cheap cascade generalizes, and beats Lite

The GLM→Opus empty-patch cascade run on the FULL SWE-bench **Verified (500)**, official `swebench` gold eval:
**278/500 resolved = 55.6%**, Wilson 95% CI **[51.2%, 59.9%]** (Total 500, completed 447, resolved 278, ~53 empty
even after Opus escalation). Cost ~**$0.15/instance** (estimate: GLM-5.2 base on 500 + Opus-4.8 escalation on the 167
empty-patch tail; per-instance cost not captured in preds — flagged). Run: local on ruvultra (gcloud-independent),
cheap solve 500/500 → 167 empties → Opus escalate → merge → gold eval (run_id verified-500-cascade-local).

**This beats the Lite cascade (51.3%)** — consistent with Verified being human-validated/cleaner than Lite (no broken
instances). The empty-patch-cascade pattern (§28) is now confirmed on BOTH Lite and Verified at n=300/n=500, conformant,
at ~56×-cheaper cost than frontier-only systems. It lifts our Verified board placement from the old single-traj 46.4%
(§34) to a competitive **55.6%** — still below the frontier leaders (70-79%) on raw resolve, but the cheapest path to
the ~55% tier. A second publicly-submittable conformant result alongside the Lite PR (#453).
Authoritative per the loop rule (BATCH-eval only). Cost accounting to be tightened before any Verified submission.

### 46b. LCB at honest n=100 — robust extractor + cost-cascade to a reasoner (+8 attributable, +18 raw with temp-0 noise)

Re-ran LCB at a **larger, balanced n=100** (the §46 n=25 was easy-skewed) with two measured levers: a **robust code
extractor** and a **cost-cascade to a reasoning model**. The two failure modes §46 diagnosed (extraction misses;
public-test repair overfit) drove both fixes.

**Manifest (contamination knob intact, no easy-skew).** Balanced n=100 from release_v5's **≥2024-11-01** window
(113 problems; the strict ≥2024-12-01 window has only **56**, so n=100 is impossible there — Nov is still post-cutoff
for deepseek's disclosed cutoff). Mix: **easy 31 / med 35 / hard 34**, 53 AtCoder / 47 LeetCode, 53 stdin / 47
functional. Far more representative than the n=25's 9/8/8 easy-lean. `build-manifest.py` now also persists `metadata`
(carries `func_name`) so the functional public-test gate is faithful. `lcb-v5-n100.json`.

**Eval validated FIRST (§42/§46 discipline).** Against the ≥2024-11-01 window: known-correct (1 stdin + 1 functional)
→ **pass@1 = 1.0**, empty + wrong → **pass@1 = 0.0**. Both I/O modes discriminate. Number is trustworthy.

**Fix 1 — robust extractor (the cheap §46 win).** Old extractor took the *last* fenced block; 2 of the n=25 misses had
the real code in an *earlier* block (reasoning-prose trailing). New extractor prefers **the largest python block that
parses** (py_compile), with a solution-shape score (`class Solution` for functional / `input()`/`stdin`/`print` for
stdin), falling back to the official last-fenced rule — **byte-identical to the official `extract_code` on the common
single-trailing-block case**. Cut empty extractions to **4/100** single-shot; the cascade's reasoner recovered 2 of
those 4 to PASS. 89/96 non-empty single-shot extractions parse cleanly (the 7 that don't are genuinely broken model
output, not extraction bugs). 5/5 extractor unit tests pass (incl. the §46 code-not-in-last-block case).

**Fix 2 — cost-cascade (the SWE-bench-winning pattern, applied to LCB).** Cheap `deepseek-chat` base on ALL problems;
escalate to **`deepseek/deepseek-r1-0528`** (reasoner) ONLY when the base (a) emits empty/no-code, OR (b) **fails the
PUBLIC example tests** (the ones shipped IN the problem statement). CONFORMANCE: the hidden grading tests are NEVER run
during solving/selection — they stay with `custom_evaluator` for final scoring. The public-test gate now runs **both**
modes (stdin via subprocess; functional via a harness mirroring the official `grade_call`: `fn_name` from starter,
args = `[json.loads(line) for line in input.split("\n")]`, tuple→list normalize) — so functional/LeetCode problems
finally get an escalation signal (§46's repair arm had none). Note OpenRouter's reasoner id is **`deepseek-r1-0528`**;
`deepseek/deepseek-reasoner` is NOT a valid OpenRouter model id (the DeepSeek-native name doesn't route).

**Result (SAME instances, official harness):**
| arm | pass@1 | Wilson 95% | $/problem | $/solved | escalation |
|---|---|---|---|---|---|
| **A** single-shot (robust extractor) | **44/100 = 44.0%** | [34.7, 53.8] | $0.00163 | $0.0037 | — |
| **B** cost-cascade (→r1-0528) | **62/100 = 62.0%** | [52.2, 70.9] | $0.01144 | $0.0185 | **27%** |

By difficulty — A: easy 27/31, med 12/35, hard **5/34**. B: easy 27/31, med 19/35, hard **16/34** (gains concentrate
on med+hard, exactly where escalation fires; easy unchanged since the base passes public there).

**Is the delta real? Yes — but the raw +18 is inflated by temp-0 noise (the honest part).** Paired (same instances):
McNemar exact two-sided **p = 1.4e-3**; paired delta **+18.0pp, 95% CI [7.9, 28.1]** (excludes 0). BUT **temp-0 is NOT
deterministic on OpenRouter** — all **73/73** non-escalated problems got *different* code between the two runs. So the
raw 44→62 conflates the cascade lever with run-to-run variance. Decomposed: on the **27 escalated** problems (the only
DESIGNED difference), single-shot solved **4**, the reasoner solved **12** → **+8 net attributable to escalation**
(reasoner cracked 12/27 = 44% of the hard tail the cheap base couldn't); the remaining ~+10 of the +18 is temp-0 noise
on the non-escalated 73. **Honest headline: the cascade's attributable lift is +8 on the escalated tail (≈+8pp on
n=100), at ~7× the per-problem cost; the rest of the observed gap is nondeterminism.** To get a fully clean total delta
you'd freeze the base completions (one base run feeding both arms) — a cheap follow-up if precision matters.

**Cascade recovered the §46 failure classes.** The 2 extraction-failures that survived the robust extractor → PASS via
the reasoner; hard problems lifted 5→16. Unlike §46's public-test *repair* (which overfit the visible sample and
regressed), public-test *escalation to a stronger model* doesn't overfit — it swaps in a better prior rather than
hill-climbing the one visible case. 6 problems regressed (single PASS → cascade FAIL); 4 of those 6 were non-escalated
(temp-0 flips), only 2 were escalation-caused.

**Contamination/comparability caveat (unchanged, honest).** Window post-cutoff so contamination-resistant by
construction, but the deepseek snapshot's exact cutoff is unpinned. n=100 is **directional** (wide-ish CI) but now
**balanced, not easy-skewed**, so the 44% single-shot sits much closer to the official whole-release_v5 ~34% population
than the old 64% — still NOT 1:1 (different window + sampling). Budget: both arms together $1.31 (A $0.16 + B $1.14),
well under the $12 cap. Files: `solve-lcb.mjs` (robust extractor + `--cascade`), `lcb-v5-n100.json`,
`lcb-single-n100*.json`, `lcb-cascade-n100*.json`. Board `livecodebench` tab updated to the n=100 points.

## 48. Escalation-tier probe (M2) — Opus stays best; cheaper reasoning tiers don't substitute on SWE-bench

n=25 Lite, same 25 instances, GLM-5.2 base cascade with varied escalation model (the candidate-generation lever, §44):
- **GLM→Opus-4.8: 16/25** (control — the current 51.3%-cascade tier)
- GLM→deepseek-r1-0528: **11/25** (−5)
- GLM→kimi-k2.6: **11/25** (−5)

**Verdict: M2 falsified at n=25 — no cheaper escalation tier matches Opus**, so nothing to confirm at n=300 (only winners escalate). Opus remains the escalation model for the empty-patch cascade. **Notably contrasts §46b (LiveCodeBench), where deepseek-r1 cracked the hard tail (+8):** competitive-programming rewards raw reasoning, but SWE-bench repo repair rewards **agentic/tool-use** capability on the hard tail — Opus's edge — which cheaper reasoning models don't substitute for. The right escalation model is **task-dependent** (r1 for self-contained codegen, Opus for agentic repo repair).
Honest caveat: the r1 VM ran very slowly (hours of reasoning), so part of its 0-net-rescue may be timeout/malformed-output suppression rather than pure capability; but kimi (fast) also landed 11/25, so "Opus is meaningfully the best escalation tier" holds. n=25 is directional (the escalation only touches ~8-14 empties). Real measured numbers; no n=300 spent on a non-winner.

## 49. Turn-budget lever (maxsteps 15→30) = null on Lite — the cheap frontier is fully mapped

n=25 Lite, GLM→Opus cascade, base solve at maxsteps=30 vs the maxsteps=15 control (same instances):
- **maxsteps=15: 16/25** (control)
- **maxsteps=30: 14/25** — no lift (within n=25 noise; if anything marginally lower).

Doubling the base turn budget does NOT improve the cheap cascade on SWE-bench Lite — the GLM base **saturates by ~15 steps** on Lite's focused single-bug repos. **Contrasts SWE-bench Pro** (§40/§45), where turn budget was the *biggest* lever (50→250 turns = +31pt): Pro's large enterprise repos need navigation depth, Lite's don't. So turn budget helps only where the task needs depth, not where the model saturates — consistent + task-dependent, like the escalation-model finding (§48).

**Conclusion — the cheap-conformant cost-Pareto frontier is FULLY MAPPED.** Every cheap candidate-generation lever is now explored and null/inferior:
- Selection/localization: exhausted (§35/§38/§44)
- Cheaper escalation tiers (r1, kimi): don't match Opus (§48)
- Turn budget: no lift on Lite (§49, this)

**GLM→Opus empty-patch cascade @ maxsteps=15 is the optimum** for this approach: **51.3% Lite / 55.6% Verified**, conformant, ~56× cheaper than frontier-only. Further resolve requires either more spend (frontier base — off the resolve-per-dollar thesis) or a fundamentally different generator (ADR-153 agentic-loop architecture — out of this budget). Per the loop stop-condition: no cheap resolve-rate lever remains → stop new paid runs, idle on health+upkeep.

## 50. Escalation-tier sweep COMPLETE (n=25) — Opus uniquely best; only BoN beats it

GLM-5.2 base cascade, escalation tier varied, same 25 instances:
- **Opus-4.8: 16/25** (best single tier)
- GPT-5.5: 12 · Haiku-4.5: 12 · deepseek-r1: 11 · kimi-k2.6: 11 · **Sonnet-4.6: 11**

**No cheaper escalation tier matches Opus** — not a cheaper Claude (Sonnet/Haiku), not a frontier GPT, not a reasoning model. Opus-4.8 has a unique agentic-repo-repair edge on the hard tail. The cost-Pareto-cheaper-escalation question (M2) is now FULLY closed: Opus stays.

**The ONLY config that beats single-Opus is test-time compute:** `xbo:opus+glm = 18/25` (Best-of-N + conformant judge) > Opus-cascade 16/25. So the SOTA-breaking lever is **BoN/ensemble, not model choice** — which is exactly what the Darwin config-evolution (§51, in flight) is now searching: the best frontier-combination BoN on the hard tail. Conformant throughout (Best@k judge, no gold tests). n=25 directional; winner → n=300 validate.

## 51. ADR-195 Phase-2 capability stack — BUILT (validation pending budget)

The structural blockers no Phase-1 config toggle can fix (the Opus-give-up tail) get NEW solver code,
each exposed as a Phase-2 genome gene (off by default) so per-instance evolution can measure coverage
lift LATER. Shipped build-only ($0 — zero paid GCP/OpenRouter runs):

- **`localize.mjs`** (`--localize`) — RuVector-HNSW retrieval-seeded localization. Chunk repo source at
  function/class granularity → embed (code-capable model) → ruvector `VectorDB` HNSW index → retrieve
  top-k → optional `--gnn-rerank` score-diffusion → ranked file/symbol seed injected as the agent's
  turn-1 file surface. Built FIRST (strong prior for the hard tail; RuVector-ready). Pure core wired to
  the native `ruvector` npm addon (`VectorDB`, Cosine) + OpenRouter embeddings; 10/10 unit tests offline
  (stub embedder + in-memory cosine index — no network, no native dep). RuVector path = the production
  version of the worktree-a29099 probe (`ruvector-localize.mjs`).
- **`repro-gate.mjs`** (`--repro-gate`) — reproduction-first iterate loop (conformant TDR analog,
  stronger than §44's weak gate). Reuses `test-critic.buildReproTest` (a VALID repro FAILS on the buggy
  code), then iterates the patch in bounded rounds until the self-written repro passes (the only signal;
  never the gold test). 5/5 unit tests.
- **`reviewer.mjs`** (`--reviewer`) — critic sub-agent + bounded revise loop (ADR-176 review role).
  Reviews correctness/regressions/scope, drives a bounded revise loop on REJECT. 8/8 unit tests.

Genome wiring (`evolve-config.mjs`): `localize`/`reproGate`/`reviewer` boolean genes, all default OFF.
`gkey`/`readbackKey` append a stable sorted `+loc/+repro/+rev` suffix ONLY when a gene is on, so
pre-Phase-2 genome keys are byte-identical (backward-compatible Firestore readback). `mutate` can flip a
gene; `crossover` inherits each independently; three capability probes added to the seed population.
8/8 Phase-2 genome tests + all existing genome tests still green.

**Status: implemented (build), validation pending budget.** Validate each later via per-instance
evolution with the new gene (`evolve-perinstance.mjs`), e.g. a HARD-25 single-instance probe with the
capability flag forwarded to `solve-agentic.mjs --no-test-oracle <flag>`. NO paid runs were made.

## 52. RuVector-HNSW retrieval-seeded localization (feasibility probe, n=5) — did NOT help; plausibly hurt

Hypothesis: the HARD-25 (Opus give-ups) fail on **localization** — the ReAct agent never finds the
fix site in a big repo before its step budget runs out. Candidate fix: seed the agent's starting
"localization surface" with a retrieval engine. Built a prototype (`bench/swebench/ruvector-localize.mjs`):
clone repo @base_commit → chunk source at def/class granularity → embed chunks + issue with
`openai/text-embedding-3-small` → build a **RuVector HNSW index** (native `ruvector` npm 0.1.100 addon)
→ retrieve top-k → emit ranked {files, symbols} → prepend to the problem statement via
`solve-agentic.mjs --localize-seed`. Conformant (issue text + repo source only; test dirs excluded
from the index; gold tests never touched).

**A/B on 5 diverse hard instances, Opus-4.8, conformant (`--no-test-oracle`), maxsteps=20, one run/arm:**

| instance | gold-fix file | seed rank (recall@12) | baseline patch | seeded patch |
|---|---|---|---|---|
| psf__requests-2674 | requests/adapters.py | **MISS** | empty | empty |
| django__django-11564 | django/conf/__init__.py | **MISS** (seed→staticfiles/) | **665 ch** | empty |
| pydata__xarray-3364 | xarray/core/concat.py | #4 (3 distractors above) | **1309 ch** | empty |
| pytest-dev__pytest-5103 | src/_pytest/assertion/rewrite.py | **MISS** | empty | empty |
| sympy__sympy-13895 | sympy/core/numbers.py | #4 | empty | empty |

- **Retrieval recall@12 = 2/5** (gold file present); 0/5 resolved either arm (all genuine give-ups).
- **Patches-generated: baseline 2/5 → seeded 0/5.** The seed made it *strictly worse*, not better.
- **Why the misses cluster:** every MISS has a gold-fix file that is *infrastructure/plumbing*
  (`adapters.py` wraps exceptions the issue names; `conf/__init__.py` is settings machinery;
  `rewrite.py` is assertion-rewrite internals). The issue text describes a **symptom**; the fix lives
  in a file that *uses/wraps* the named symbols but isn't lexically described. Pure semantic
  similarity retrieves the **symptom's definitions** (e.g. urllib3 `exceptions.py`), not the **fix
  site** that catches them. This is precisely the case for graph-based reranking
  (`ruvector-gnn-rerank` score-diffusion over the import/call graph: a 1-hop walk from the retrieved
  exceptions.py → adapters.py that imports it would recover the miss). The prototype did NOT wire the
  GNN reranker — that's the obvious next step.
- **Why a partial-hit seed still hurt (django, xarray):** presenting a confident "LIKELY-RELEVANT
  FILES" hint **anchors** the agent on the listed files (distractors ranked above gold) and it burns
  its step budget there instead of finding the fix via its own grep/import-following. A wrong/buried
  hint is worse than no hint — the agent's native exploration already outperformed a 2/5-recall seed.

**Cost/latency (engine works fine):** indexing 1k–4k chunks = 26–113 s/instance, **dominated by remote
embedding** (HNSW *search* is ~0.4–0.5 s — fast as advertised). Embedding cost ~$0.005–0.02/instance
(text-embedding-3-small). RuVector native HNSW: zero friction to wire from Node (`new VectorDB({dimensions, distanceMetric:'Cosine'})` + `insertBatch` + `search` — clean). Solve A/B self-cost ~$10.8
(baseline $4.74 + seeded $6.03), within the $20 cap. (Note: the shared OpenRouter key also carries the
concurrent evolution agents' traffic — `usage` delta is not a clean per-task meter here.)

**Verdict (honest, n=5 — a feasibility probe, NOT a benchmark):** RuVector-HNSW localization as a
**raw-embedding, top-k, authoritative-hint** seed **does not unblock the Opus give-ups and plausibly
hurts**, because (a) recall on the hard tail is low (symptom≠fix-site), and (b) a confident wrong hint
anchors the agent. The engine is fast and trivially Node-wireable — the bottleneck is **retrieval
quality on the hard tail**, not the index. **If pursued as a Phase-2 capability, the build-out must:**
(1) add `ruvector-gnn-rerank` (graph score-diffusion to hop symptom→fix-site); (2) present the seed as
*low-confidence/exploratory* (not authoritative) or only inject it as extra grep-able context, never as
a ranked directive; (3) validate on held-out conformant n≥300 — n=5 with one run/arm cannot
distinguish a real regression from agentic variance. Consistent with §35/§38/§44: simple
selection/localization levers keep coming back null on this tail; the residual blocker is the
generator's reasoning on plumbing-level fixes, not a missing file-finder.

## 53. Field SOTA research — our findings confirmed; one untried lever; the contamination reframe

Deep research on 2025-2026 SWE-bench harness SOTA (sources: arXiv 2506.17208 architecture survey, ORACLE-SWE 2604.07789, CoSIL 2503.22424, UTBoost 2506.09289, 2512.10218 memory-vs-ability, SEAL Pro leaderboard).

**Our harness findings are FIELD-CONFIRMED:** frontier BoN ceiling (bounded by diversity not count); naive single-pass HNSW localization anchors on "symptom distractors" (CoSIL names this exact failure — matches §52); turn-budget diminishing returns (2602.16069); cheaper escalation worse (model capability dominates). Every lever we exhausted, the field also finds insufficient.

**The hard tail is a SHARED model-reasoning ceiling:** even with ALL oracle signals (repro test + edit location + exec context + API + regression), ~3% remain unsolved; oracle *localization alone* leaves ~57% of the localization-headroom non-recoverable. No published technique cracks multi-file/symptom-distant bugs beyond raw model capability. Our reasoning-ceiling conclusion is validated.

**THE CONTAMINATION REFRAME (big):** the 80-95% Verified headlines are inflated — vendor-self-reported, contamination + weak tests (OpenAI deprecated Verified after finding verbatim gold-patch reproduction; UTBoost + ICSE-2026 find false-positive patches; 4-6x gap vs decontaminated BeetleBox/SWE-rebench). The CLEAN frontier (SEAL-standardized Pro) is **~47-59%** (Opus 4.5: 80.9% Verified → 45.9% Pro). **Our Verified cascade 55.6% is squarely IN the clean-frontier band** — we may already be matching *clean* SOTA, far below the inflated headline but at the real ceiling. Cost: our $0.15-0.27/inst is at the cheap end (Agentless $0.12-0.34, AutoCodeRover $0.70, SWE-agent $1.05, the 87%+ Verified runs ~$5-15+).

**The ONE untried high-impact lever — execution-trace localization (reproduction-first):** generate a repro test → RUN it → use the EXECUTION TRACE as the localization signal (fix-site is in the trace; symptom sits on top) → navigate trace→fix-site. This is the field's clearest hard-tail mechanism (bypasses semantic symptom-anchoring). Our repro-gate (§ADR-195) has the repro-WRITE half but NOT the trace-as-localization half. Plus CoSIL multi-pass graph-expansion-from-symptom + rerank (40-50% localization-accuracy gain). This is the real "localization done right" — distinct from the naive HNSW that failed (§52).

## 54. ADR-196 execution-trace localization — BUILT (validation pending budget)

Built the §53 #1-untried lever as new solver code: `bench/swebench/trace-localize.mjs` + a Phase-2 genome gene `traceLocalize` (default OFF) + `--trace-localize` in `solve-agentic`. **ZERO paid runs** — build + 13 offline unit tests only; full darwin-mode suite (549 tests) + tsc clean.

**The mechanism (why it differs from the §52 naive localizer that failed):** §52's HNSW seed ranks by *text similarity to the issue* → anchors on **symptom distractors** (code that looks like the issue = where the symptom manifests, not the fix-site). ADR-196 ranks by *observed execution*: REUSE the ADR-195 repro-WRITE (`test-critic.buildReproTest`) → RUN the failing `reproduce_bug.py` under a **stdlib `sys.settrace` tracer** in the conformant base env (deps present, gold test_patch NEVER applied) → capture the ordered `(file,func,line)` frames + the failure **traceback** → rank "from symptom outward" (innermost traceback frame = the raise site = most-probable fix-site leads; then trace-touched files by execution centrality) → seed the agent as **EVIDENCE** ("the failing reproduction executed through these files"), explicitly NOT an authoritative directive (the §52 anti-anchoring lesson). A high-frequency file *off* the failure path ranks **below** any file *on* it — structurally cannot anchor on a symptom distractor.

**Trace-capture used:** Python stdlib `sys.settrace` line tracer (`buildPyTracer` → staged `trace_repro.py`), frames filtered to repo source under `/testbed`, emitted as a JSON block between `@@DARWIN_TRACE_BEGIN/END@@` sentinels for robust extraction from a noisy log tail; the tracer re-raises so the repro's non-zero exit is preserved. **No new dependency** (no pip install, no native addon — unlike the RuVector path §52).

**Honesty guards (no fabricated localization):** if the repro is invalid, the trace can't be parsed, or no repo-source frame was touched → `seed:null`, NO hint injected (§52: a wrong confident hint is worse than none). Composes with `--localize` (trace evidence leads) and `--repro-gate` (trace seeds *where*, gate verifies *correct*). Default-OFF gene → byte-identical pre-Phase-2 genome keys.

**Honest ceiling (§53):** even with ALL oracle signals ~3% are unsolvable and oracle-localization alone leaves ~57% of localization-headroom non-recoverable — the tail is a shared model-reasoning ceiling. This is a *targeted* lever (helps instances whose fix-site is on the repro's execution path but outside the agent's native budget), NOT a silver bullet. **Validation ran §56.** Like every localization lever before it, no claim until held-out conformant n≥25.

## 55. Terminal-Bench adapter — BUILT + EVAL-VALIDATED + hardest probe (1/6 on the hard tail, $0.09)

Built the `terminal-bench` board end-to-end and ran it for real (local Docker), mirroring the proven LCB/swebench adapter pattern: a thin port of our agentic ReAct loop onto the OFFICIAL `tb` harness, scored by the harness's OWN hidden tests (we never hand-rolled a scorer).

**What shipped** (`bench/terminal-bench/`): `darwin_terminal_agent.py` (a Python `BaseAgent` ReAct shell loop over OpenRouter with per-task `$` capture), `build-manifest.mjs` (hardest-first manifest from each `task.yaml`'s declared difficulty — 24 hard / 44 medium / 12 easy), `hardest-first.mjs` (crack-the-tail scheduler over `tb`, with a live spend breaker), `score.py` (joins the official `results.json` + our `darwin-cost.jsonl` → the cost-Pareto row), `run.sh`, `requirements.txt`; plus the GCP board `scripts/tbench-gcp.mjs` + `scripts/gcp-tbench-runner.sh` (self-running quota-aware `darwin-tb-*` VMs that install `tb`, run the eval-validation gate, run hardest-first, self-report to Firestore `darwin_tbench_runs`, autostop).

**EVAL VALIDATED FIRST (§42, non-negotiable, PASSED):** on `hello-world`, the official **oracle** agent (applies the task's reference `solution.sh`) scored **100% PASS**; the **nop** agent (does nothing) scored **0% FAIL**. The eval discriminates correct from empty → the number is meaningful. Then our own agent solved `hello-world` through the official eval at **$0.000231** (full pipeline proven).

**THE tmux framing bug (the one real gotcha, fixed):** the model's first command was a heredoc (`cat > f <<'EOF' … EOF`); sent line-by-line to tmux it parked the shell at a PS2 `> ` continuation prompt, after which every command fed a dead prompt and each `send_keys(block=True)` burned its full timeout. Fix: run every command base64-encoded as ONE physical line (`printf %s '<b64>' | base64 -d | bash; echo MARKER$?`) — heredocs/quotes/newlines survive, tmux sees one line. After the fix `hello-world` solved in 2 steps.

**HARDEST PROBE (deepseek/deepseek-chat, hardest 6 of terminal-bench-core 0.1.1, conformant — agent never sees the hidden tests):**
- **Resolve: 1/6 = 16.67%.** Cracked: `organization-json-generator` (hard/file-operations). Failed: `write-compressor`, `blind-maze-explorer-5x5` (hard, agent maxed its 25-step budget), `path-tracing` + `path-tracing-reverse` (the TASK's own test command timed out at 60s — heavy rendering, harness-scored unresolved), `extract-moves-from-video` (AGENT_TIMEOUT at 360s — the model assumed internet and retried `yt-dlp`/`curl youtube.com`, but the task containers are NETWORK-ISOLATED for reproducibility).
- **Cost (authoritative = our sidecar): $0.0876 total · $0.0146/task · $0.0876/resolved.** Trivially cheap; n=6 so directional only.
- **Honest read:** 16.7% on the HARDEST band with a cheap non-reasoning model is a legitimate low-accuracy/low-cost Pareto point (as expected — Terminal-Bench-Core is hard; the public cheap-model band is single-digit-to-teens). Two of the 5 misses are task/harness properties (test-timeout, network-isolation), not adapter bugs. The directional next levers: a reasoning model on the hard band, a larger step budget, and a system-prompt note that the env is offline (the extract-moves failure is a pure strategy fix).

**Scaling plan (hardest→up):** `hardest-first.mjs --ladder` runs band-by-band (hard, then medium, then easy), scoring after each, stopping on the spend breaker — so the easy/medium bands (where a cheap model should do much better, lifting the headline) come after the tail is mapped. GCP scale-out via `tbench-gcp.mjs matrix` (deepseek/glm/kimi × hard band, concurrent, autostop). Local is the validated path for small probes; GCP for the full 80.

**Spend:** probe sidecar $0.0876 (well under the $25 cap). The OpenRouter abs-delta over the run window was ~$5.6, but that conflates the concurrently-running darwin-pi fleet sharing the same key — our probe's true cost is the sidecar sum.

## 56. ADR-196 execution-trace localization — A/B RAN: it moved the hard tail (+1 crack), but a harness truncation bug had to be fixed first

The §54 "validation pending budget" A/B was run **locally on ruvultra** (Opus 4.8 via OpenRouter, conformant `--no-test-oracle`, gold scores only — gold harness never in-loop, leakage guard clean). Both arms on the SAME hard instances (the 25 Opus-give-ups in `hard-lite-ids.json`). Real numbers below; n is small (1 run/arm) so this is **directional**, not a benchmark.

**THE HARNESS BUG (found by the §54 honesty check "verify the trace actually fired"):** the first Arm-B run produced `traceLocalized:false` on every instance — `parseTrace` reported "no parseable trace block". Diagnosis: the tracer **did** fire and emit a complete valid JSON block, but `runConformantTests` slices its output to the **last 2500 chars** (`out.slice(-2500)`). On any non-trivial repo the trace JSON (the `counts` map alone lists every touched source file) exceeds 2500 chars, so the `@@DARWIN_TRACE_BEGIN@@` sentinel was truncated off the front of the tail — only `TRACE_END` survived → `lastIndexOf(BEGIN)` returns −1 → silent `ok:false` → **every trace seed became null → the lever was a silent no-op.** Without the §54 fire-check this A/B would have measured nothing and "confirmed" trace-localize does ~0. Fix: opt-in `tailBytes` option on `runConformantTests` (default unchanged 2500; trace caller requests 200 KB). After the fix, trace **fired 8/10** on the re-run (failures: matplotlib-25079, django-11564 — repro didn't raise a parseable repo-frame traceback). **Lesson banked: a localization lever that silently returns null is indistinguishable from "the lever doesn't work" — always assert the signal fired before reading the A/B.**

**THE RESULT (matched instances, conformant, gold-scored):**
- **Arm A (baseline, single Opus, no trace):** 24/25 ran (1 capped on budget) → **0 resolved.** 22 of 24 were empty patches (no_generation give-ups) — these instances are genuine give-ups, confirmed.
- **Arm B (`--trace-localize`):** budget-constrained to a focused **10-instance subset** (see cost note) → **1 resolved: `pylint-dev__pylint-7228`.**
- **DELTA on the matched 10: trace − baseline = +1.** And it's the strongest kind of signal: baseline produced an **empty patch** for pylint-7228 (gave up, 15 steps, never submitted); trace-localize fired, seeded `pylint/config/argument.py` (the regex-compile site on the failure path), and the agent wrote a **correct** patch in **72 s** (vs baseline's 225 s of wandering) that **passes the gold test**. Execution-trace evidence cracked an instance single-Opus had no_generation on.

**VERDICT — it moves the hard tail, but modestly and the tail is still mostly a reasoning ceiling.** This is the FIRST hard-tail lever in this whole arc to convert a confirmed Opus give-up into a gold-resolved fix (every prior localization/BoN/cascade lever returned ~0 on the hard tail). So the §53 hypothesis is **directionally confirmed**: observed-execution localization is qualitatively different from the §52 symptom-anchoring naive HNSW — it doesn't just fail differently, it actually helped. BUT: 1/10 is not a transformation; 8 instances still produced no patch even with the trace fired; 2 instances couldn't be traced at all. The bulk of the tail remains the shared model-reasoning ceiling §53 describes. Trace-localize is a *targeted* lever (it helps when the fix-site is on the repro's execution path but outside the agent's native search), exactly as predicted — not a silver bullet.

**COST NOTE (a real budget-enforcement bug, banked):** Arm A's solver-internal cost meter reported $22.07 for 24 instances, but the OpenRouter **account** billed ~$38.84 over the same window — Opus 4.8's true cost is **undercounted ~1.7-1.8x** in the `usage.cost` field the solver reads, so the in-solver `--max-cost` cap does NOT enforce the real dollar budget. The ~$40 session cap was consequently overshot to **$58.78 total** (Arm A $22 + Arm B $9 internal). Two consequences: (1) `--max-cost` is unreliable as a hard budget guard with Opus on OpenRouter — gate on the account `auth/key` usage delta, not the solver's self-report; (2) Arm B had to be cut to 10 instances (not the full 25) to bound the overshoot, so the A/B is n=10 matched, not n=25. **Recommendation:** the +1 crack on a confirmed give-up is enough signal to justify a **conformant n=300 validation** of `--trace-localize` (now that the truncation bug is fixed and the fire-rate is 8/10) — but only with account-level budget gating and a per-instance trace-fire assertion in the harness.

## 57. Per-instance config-evolution (ADR-194) — the diagnosed config-only levers crack 0/25 of the Opus-give-ups

Built `evolve-perinstance.mjs` + `gcp-perinstance-runner.sh`: each of the 25 hard Lite instances
(`hard-lite-ids.json`, the Opus give-ups) gets its OWN tiny Darwin evolution over a CAPABILITY genome;
fitness = k-sample (k=2) **conformant** resolve on that ONE instance (gold scores only the finished
patches, never seen while solving — solver runs `--no-test-oracle`). Per-(instance,genome) probes were
dispatched as real GCP e2-standard-4 VMs self-reporting `resolved_k/k` to a new Firestore collection
`darwin_inst_runs`. **Conformance firewall (central):** per-instance gold-tuned configs are TUNING ON
THE TEST (HV-1) → OVERFIT, NOT claimable. The deliverable is the COVERAGE MAP + the generalizable
capability set, to be validated as ONE conformant harness / non-gold router on held-out n=300.

**COVERAGE MAP (real Firestore numbers, n=25 instances, k=2): 0/25 cracked, 0 robust.**
The run was WOUND DOWN (coordinator directive) once the signal was clear, redirecting budget/quota to the
§56 trace-localize n=300 validation. Cheapest-first dispatch + early stop means **two** config-only
capabilities completed across all instances measured:
- **cheap-single** (`single|z-ai/glm-5.2`): 25/25 instances → **0/2 every one**.
- **cheap→Opus cold-escalation cascade** (`cascade|glm-5.2>claude-opus-4.8`): 15/25 instances → **0/2 every one**.

The cascade routes every cheap-base repo-gate miss to Opus (cold, fresh work tree) and **Opus still yields
0/15 conformant resolves** on these give-ups — strong evidence the hard tail is **reasoning/localization-
ceiling-bound, not cheap-model-bound**. ~46 probes, ~$107 incremental (budget went $1052→~$1159 over the
run, shared with live experiments).

**HONEST SCOPE CAVEAT (do not overclaim):** the DIRECT frontier-single (`single|claude-opus-4.8`),
+turn-budget (`s20`), Best-of-N width (`bo3|opus`), and cross-model BoN (`xbo|opus+glm`) genomes were
QUEUED but NOT measured before wind-down. So this proves **cheap-single + cheap→Opus-cascade crack 0/25**
— it does NOT by itself prove ALL config toggles fail (direct-Opus / BoN on the hard tail remain
undiagnosed here; note §50 separately measured `xbo:opus+glm = 18/25` on the SAME hard-25 in aggregate,
i.e. BoN DOES crack ~some of them — consistent with "config-only is partial, not zero, but cannot close
the tail"). The defensible conclusion: **config-only levers cannot close the Opus-give-up tail; the
levers that move it are NEW harness capabilities** — exactly §56's trace-localize (the one give-up that
cracked did so via trace-localization, a new capability, not a config toggle). → ADR-195 Phase-2
capability stack: priority (1) trace-localize n=300 validation, (2) reproduction/repro-script generation,
(3) self-review/reviewer pass. Full coverage artifact: `bench/swebench/evolve-perinstance-coverage.json`.
## 58. Conformant n=300 trace-localize validation — RUNNER PLUMBED + SHIPPED; paid dispatch ABORTED on the account-budget gate

**Step 1 — DONE & SHIPPED to main.** The GCP runner did not forward any Phase-2 solver flags. Threaded `TRACE=1` (instance-metadata/env) → `--trace-localize`, default-OFF and backward-compatible (control arm = the unchanged shipped cascade). Placement is deliberate per §56: in `(e|x)cascade` the flag is forwarded ONLY to the **Opus escalation tier** (the empty-patch give-ups — the exact hard-tail surface trace-localize cracked, pylint-7228), and is **never** applied to the cheap GLM base (which would change the §28/§47 control behavior and burn budget re-solving already-resolved bulk). For single-tier modes it applies to the only solve. Mirrors how MAXSTEPS/HARD are threaded `gcp-cluster.mjs → runner`. Verified: `bash -n` + `node --check` clean; flag-derivation truth table correct per arm/mode; 13 trace-localize unit tests pass; runner live on `main` raw URL (the fleet fetch path). Commits `c0bce5c` (branch) + `21e4d2e` (main).

**Step 2 — paid A/B NOT dispatched. Hard-stopped by the account-budget gate (the §56 lesson, applied).** The task specified the gate as "+$120 account spend, current total ~$1160/$1500, abort dispatch if exceeded." On querying the OpenRouter account `auth/key` usage at run time (the correct meter per §56 — NOT the solver self-report), the account stood at **$2211.11 total** (`usage_daily` $59.71, `usage_weekly` $1713.56). That is **~$711 past the $1500 ceiling the task referenced** and ~$1050 past the stated "$1160" baseline — i.e. substantial spend has happened since the directive was written. Per the directive's own rule ("abort dispatch if exceeded"), I did not dispatch the paid n=300 run. This is the budget discipline §56 was banked to enforce: gate on the real account delta, and stop when it's blown — do not spend into an already-breached ceiling on the assumption the stated baseline still holds.

**Quota also not clear yet (secondary).** Per-instance diagnostic VMs were still RUNNING at check time (`darwin-pi-django-12113`, `darwin-pi-sphinx-8435`, `darwin-pi-sphinx-8474`). The directive said to wait for these to free and not kill running experiments — so even absent the budget block, this was not the window to dispatch.

**What's ready the instant budget is authorized:** one `gcp-cluster.mjs` provision with `TRACE=1 MODE=ecascade BENCH=lite` (full-300, GLM base → Opus-on-empties + trace), `ESCCOST` set low, account-delta gated to +$120 hard. Control = the existing §28/§47 51.3% submission preds (reuse, no re-run). Treatment gold-eval → resolve %, Wilson 95% CI, delta vs 51.3%; assert `traceLocalized:true` fires on a meaningful fraction of the escalated empties before reading the delta (§56 fire-check). **Honest standing expectation (unchanged from §56): a SMALL lift (~+1-5 instances) likely WITHIN the Wilson CI** — trace-localize is a targeted hard-tail lever, and on full Lite-300 the bulk is already solved. A within-noise result will be recorded honestly as such, not spun.

(Note: §57 above independently confirms the directive's stale baseline — that run measured budget $1052→~$1159; the account has since climbed to $2211.11, the gate this §58 enforces.)
