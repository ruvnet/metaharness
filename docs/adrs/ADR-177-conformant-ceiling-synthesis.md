# ADR-177: The conformant ceiling — ablation synthesis + honest path (SOTA push conclusion)

**Status**: Accepted (architecture conclusion; cheap-lever search exhausted)
**Date**: 2026-06-23
**Project**: `ruvnet/agent-harness-generator`
**Closes**: the ADR-173/174/176 leaderboard-conformant SOTA push (this session). Tracked in #45.

## What we set out to do
A LEGITIMATE, leaderboard-conformant top-10 on SWE-bench Lite (≥45%) at the cost-per-resolve frontier
("lowest cost at best intelligence"). Conformant = the solver never sees the gold FAIL_TO_PASS/PASS_TO_PASS
during solving; gold scores once at the end. Only batch-eval numbers + Wilson CIs claimed; nothing fabricated.

## The complete ablation (all gold-graded, conformant, 25-instance Lite pilots unless noted)

| config | gold resolve | $/inst | note |
|---|---|---|---|
| DeepSeek search-applicator (floor) | 5/25 = 20% | $0.02 | |
| DeepSeek line-applicator | 4/25 = 16% | $0.02 | attempt-rate 44→80%, **no resolve lift** |
| DeepSeek line + repro-gap-fix | 3/25 = 12% | $0.02 | repro-valid 68→80%, **no lift (Goodhart)** |
| Opus critic + DeepSeek coder (A′) | 4/25 = 16% | $0.08 | strong oracle, **no lift** |
| DeepSeek critic + qwen3-coder | 0/25 = 0% | — | qwen doesn't transfer |
| Opus critic + qwen3-coder | 1/25 = 4% | — | qwen doesn't transfer |
| + Opus sniper on DS tail (hybrid) | 4/25 = 16% | $1.01 | **sniper added 0 gold (overfits repro)** |
| DeepSeek + plan-then-edit (L2) | 4/25 = 16% | $0.08 | **no lift** |
| **Opus critic + Opus coder (best-of-3)** | **6/18 = 33%** | **$3.49** | **the only config that lifts — frontier coding** |

## The findings (each measured, CIs wide at n=18-25 — directions are clear)
1. **The coder binds, not the oracle.** A strong Opus repro lifts the cheap coder only 12→16% (noise).
2. **Cheap-Pareto-SOTA is falsified.** Opus-oracle + cheap-coder (16%) ≠ frontier (33%). A faithful
   contract can't make a cheap model *write* a cross-file fix it can't reason out.
3. **Every cheap lever is null** (oracle, qwen swap, asymmetric sniper, plan-then-edit) — and they all
   resolve the *same 4 "easy" instances* (astropy-12907, django-14411, pytest-5227, sklearn-13779).
4. **Goodhart is structural.** Higher self-repro-pass rates correlate with *lower* gold (the sniper drove
   in-loop 7→23/25 with 0 gold gain). A weak model's self-test is an unreliable selection target; even a
   single Opus repro-gated shot overfits — only Opus **best-of-k diversity** converts.
5. **Even frontier caps at 33%** — far below Opus's 76.8% Verified via mini-SWE-agent. So **the scaffold
   (MCTS + self-repro gating + our localization) is itself a ceiling**, independent of model tier.

## Decision — the cheap-lever search is exhausted; the remaining path is a different class of work
No conformant lever in this scaffold reaches the 45% top-10 bar. A real top-10 attempt requires BOTH:
- **frontier best-of-k coding** (~$3.49/inst → ~$1000 for a full-300 run = the entire SOTA budget, for a
  result that on these pilots projects to ~33% — i.e. **still below top-10**), AND
- **a fundamentally stronger scaffold** — real agentic file navigation + execution feedback +
  ground-truth-free regression gating (mini-SWE-agent-v2 idioms), *replacing* MCTS+self-repro, not tuning
  it. That is a multi-week build, outside this loop's scope.

**Therefore:** stop the autonomous cheap-lever search (exhausted). Do **not** autonomously spend ~$1000
on a full-300 Opus run for a projected sub-top-10 (~33%) number — that decision needs explicit human
go/no-go (poor ROI for a non-placing result). Idle on health + upkeep per the loop directive.

## What this session DID deliver (the real contributions)
- A **rigorous, honest conformant ablation** that maps exactly what cheap-model conformant repair can and
  cannot do — a result the field's "SOTA at pennies" narratives lack.
- Reusable infrastructure: conformant Docker test-runner, Test-Critic, line-applicator, container-reuse,
  `--critic-model`/`--patch-model`/`--sniper`/`--plan`/`--pause-for-test-review` (ADR-174/175/176).
- The **dual-mode product (ADR-175)**: oracle-ON Test-Driven Repair (**68.3%** with the user's test) is
  the shippable, honest product number; conformant mode is the harder no-test capability.
- Downstream-validated design (#47 Goodhart) — now empirically confirmed.

## Open options for the human (not taken autonomously)
1. **Spend ~$1000** on a full-300 Opus best-of-3 conformant run → a real (~33%, sub-top-10) submittable
   number + a Pareto-cost data point. (Poor placement ROI; real research value.)
2. **Build the mini-SWE-agent-v2-class scaffold** (multi-week) — the only credible path to ≥45% conformant.
3. **Ship the product** (dual-mode darwin; TDR 68.3%) and treat the conformant number as a research result.
