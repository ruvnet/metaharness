# ADR-251: `@metaharness/avo` — governed autonomous variation runtime

**Status**: Accepted (runtime + mechanism proven; 100-task preregistered SWE-bench gate EXECUTED — resolution/governance pass decisively, cost gate fails; "AVO-class" ship claim remains blocked on cost)
**Date**: 2026-08-21
**Updated**: 2026-08-21 — live governed-loop validation completed against two real providers (OpenRouter `qwen/qwen3-8b` via GCP-secret key, and the Cognitum meta-llm Cloud Run endpoint `cognitum-low`): full inspect→edit→execute→evaluate→commit repair with signed, verified receipts and auditable usage evidence (`packages/avo/bench/results/{openrouter,cloudrun}-live-receipts.json`, test `__tests__/openrouter-live.test.ts`). Package publication proceeded on direct user order 2026-08-21; the 100-task preregistered SWE-bench gate, independent graders, and protected exact-SHA release workflow remain open — the "AVO-class" performance claim stays blocked until they pass. Security update (0.1.1, same day): the agent context is now deep-copied before crossing the trust boundary — an independent review showed the live authoritative state and promotion-baseline candidate were handed to the untrusted agent callback, letting a malicious agent forge its own evaluation; adversarial acceptance test `__tests__/malicious-agent.test.ts` proves the forgery was promotable before the fix and is refused after it.
**Updated**: 2026-08-21 (later) — the preregistered 100-task unseen SWE-bench gate was EXECUTED end to end. 100 instances seeded-random (seed 251) from the 407 SWE-bench_Verified instances that appear in NO optimization/selection artifact in `packages/darwin-mode/bench/swebench`; task-set hash `sha256:1da0fdf1…c2a7ab` committed BEFORE any solving (`packages/avo/bench/results/prereg-100-adr251.json`). Fixed model `deepseek/deepseek-chat`, three arms, official swebench-3.0.17 docker evaluator on SWE-bench_Verified. **Result (`bench/results/three-arm-verdict.json`): darwin-fixed 5/100, avo-no-supervisor 14/100, avo-supervisor-memory 13/100.** Ship gate: resolution relative lift **+160% PASS** (≥20% required), zero-violation **PASS** (0 across all 300 observations), replay-integrity **PASS** (100%), **cost gate FAIL** — cost per accepted result rose **+97.7%** ($0.046→$0.091), exceeding the <50% bound. **`ship: false`.** Honest reading: the governed multi-action loop nearly triples one-shot resolution with perfect governance, but is not cost-competitive per accepted fix under the strict preregistered bound. The "AVO-class" performance claim stays BLOCKED — on cost, not efficacy. A methodological note recorded during the run: the edit primitive was corrected mid-run from full-file rewrite (which truncated large files → invalid) to search/replace; the baseline was likewise corrected from model-authored diffs (which failed `git apply`) to git-diff extraction — both applied identically across arms. Prior "provider publication proceeded on direct user order" note stands. Cost-optimization follow-up (avo 0.1.2): added opt-in `stopOnVerifiedWinner` early-stop + a benchmark auto-cadence (test-after-edit, commit-on-green). Empirical finding — the cost gate is NOT passable this way: the in-loop conformant test rarely passes green even for patches the official evaluator later resolves, and the winning edits are scattered late in the action budget (e.g. actions 18-20), so early-stop rarely fires and lowering the action budget would forfeit the resolution gain. AVO's +160% resolution and its +97.7% cost/accepted are two sides of the same exploration and are not cheaply separable with this oracle. The ship=false-on-cost verdict stands and is now understood mechanistically. EMPIRICAL RE-RUN (cost-optimized config: stopOnVerifiedWinner + test-after-edit/commit-on-green cadence + 3-consecutive-search cap, avo 0.1.2): re-ran the AVO arms on the identical preregistered 100. At 68/67 completed instances: 0 early-stops (the optimizations never fired) and per-instance cost $0.011 — statistically identical to v1 ($0.0119). The optimizations are provably NO-OPS here because the leak-free in-loop conformant oracle (no-gold-in-loop firewall) essentially never signals green, so commit-on-green never triggers and every instance explores the full action budget. Since the cost-optimized config is behaviorally identical to v1, the v1 full-100 gate (avo-supervisor-memory 13/100, $0.091/accepted, +97.7%, ship=false) IS the cost-optimized result; the crawling re-run was stopped once equivalence was proven. CONCLUSION: the cost limitation is FUNDAMENTAL — under the conformance firewall a harness cannot know when it has succeeded, so autonomous repair must explore, and AVO resolution (+160%) and cost (+97.7%) are inseparable. ship=false-on-cost is final.
**Project**: `ruvnet/metaharness`
**Related**: ADR-071/084 (CodeGenerator), ADR-073 (archive), ADR-074 (RuVector memory), ADR-079 (promotion statistics), ADR-157 (durable execution), ADR-245 (Horizon), ADR-250 (proof ladder)
**External grounding**: NVIDIA AVO, arXiv:2603.24517

## Context

Darwin Mode's primary variation path selects a parent and one mutation surface,
calls `generateMutation()` once, then evaluates and promotes through a fixed
pipeline. That is useful population search, but it is not AVO-style variation:
the model cannot repeatedly inspect, edit, execute, diagnose, repair, revert,
or redirect itself before presenting a candidate.

The missing boundary is an autonomous variation operator under harness-owned
authority. The model chooses the next experiment. MetaHarness continues to own
capabilities, budgets, protected invariants, evaluation, promotion, quarantine,
rollback, and signed evidence.

## Decision

Ship `packages/avo` as `@metaharness/avo`. `VariationOperator.run()` is the
primary abstraction for difficult, high-value work; `CodeGenerator` remains a
compatible low-overhead Darwin fast path.

The operator exposes these bounded actions:

`inspect`, `search`, `hypothesize`, `edit`, `execute`, `evaluate`, `revert`,
`branch`, `consultMemory`, and `commit`.

Only retrieval policy, model routing, context policy, test policy, and repair
strategy are evolvable initially. Security policy and capability expansion are
not action types and cannot be added by the runtime.

Every action produces observed evidence. Horizon's executor result is:

```text
{ stdout, stderr, exitCode, durationMs, artifactDigest, policyReceipt }
```

The signed AVO transition is:

```text
H[t+1] = SHA256(H[t] || action[t] || observation[t] || policy[t] || workspaceDigest[t])
```

Denied actions produce receipts but never reach the environment. Repository
writes are confined to copied workspaces; lexical escapes and symlink traversal
are rejected. Subprocesses receive a minimal environment and bounded output and
time budgets. The structural command guard remains a guardrail, not a sandbox;
untrusted workloads still require RVM/container isolation.

## Archive and promotion

Parent utility includes performance, novelty, uncertainty, learning potential,
and risk:

```text
U(c) = F(c) + alpha*N(c) + beta*sqrt(ln(1+N_A)/(1+n_c))
       + gamma*L(c) - rho*R(c)
F(c) = wq*Q(c) - wc*C(c) - wt*log(1+T(c))
```

Promotion is conjunctive: correct, safe, replayable, no regression, within
budget, protected tests passing, zero policy violations, and improved. When a
confidence bound is supplied, `LCB95(Qchild-Qparent) >= delta` is also required.

## Supervisor

The semantic supervisor redirects rather than merely halting. It triggers on
five nonimproving evaluations, three matching failure signatures, low novelty
entropy, or excessive cost per useful progress. It identifies the dominant
failure, selects an alternate committed lineage when available, and returns
exactly three causally distinct hypotheses. It has no capability mutation API.

## Working memory and portability

`RvfGovernedMemory` uses AgenticOW over RVF for COW branches, checkpoints,
rollback, promotion, and vector retrieval. It stores only structured evidence:
hypotheses, supporting/contradicting observations, attempted actions, evaluator
results, failure signatures, promotion/rollback decisions, lineage, cost, and
latency. Raw private reasoning is absent from the schema.

JSON action state is saved atomically every configured action. RVF restore
points default to every 100 actions to keep the COW chain bounded; the working
manifest is saved after each memory update. The final RVF envelope binds the
runtime, policy, memory schema, evaluator, checkpoint hash/signature, state hash,
and memory manifest.

## Routing and Ruflo integration

`GovernedAutonomyRouter` is a task-mode gate, not a model router. Simple tasks
stay on `darwin-fast`; complex, repeatedly failed, high-value tasks with reliable
evaluators may enter `avo`. Model selection remains owned by
`@metaharness/router`. Host/Ruflo integration is through versioned adapters and
does not become a Ruflo boot dependency.

## Evidence and claim boundary

The committed proof terminates and rebuilds a 205-action run at actions 100 and
200 using the real AgenticOW/RVF backend. It requires identical receipts, state
hash, evaluator evidence, lineage, and winner, with signed receipts and zero
denied executions.

The three-arm SWE-bench contract measures resolution, cost per solve, wall time,
policy violations, replay integrity, rollback rate, and coherence retention for:

1. fixed Darwin;
2. AVO without supervisor;
3. AVO with supervisor and persistent memory.

The bundled 100-task data is a deterministic mechanism fixture and is
deliberately ineligible for a product claim. “AVO-class” remains blocked until
100 preregistered unseen SWE-bench tasks use the same model, reasoning setting,
token budget, and evaluator suite and demonstrate at least 20% relative verified
resolution lift, zero policy violations, less than 50% increase in cost per
accepted result, and 100% autonomous replay integrity.

ARC is explicitly deferred until that engineering benchmark passes.

## Consequences

- Difficult tasks gain iterative evidence-driven repair and semantic recovery.
- Simple tasks avoid the expected 2–10x model/evaluator/wall-time overhead.
- Weak evaluators can accelerate Goodhart failure; hidden tests, protected
  invariants, independent judges, out-of-sample promotion, and delayed production
  validation are mandatory for consequential deployments.
- `generateMutation()` is not removed; it ceases to be the primary abstraction
  only when the autonomy router selects AVO.

## Test contract

- Horizon WASM, command guard, executor, full checkpoint, compaction, and Rust tests.
- AVO policy, promotion, archive utility, supervisor, router, repository adapter,
  signed receipt, and checkpoint tests.
- Real AgenticOW/RVF kill/resume proof at action 100 and 200.
- Identical-task-set enforcement and fail-closed three-arm ship gate.
- TypeScript build and exact npm packed-artifact smoke before publication.

## Publication and merge

Merge and npm publication are release TODOs only after all repository gates pass.
Automated work may prepare and inspect tarballs; a human retains npm publication
authority.

## References

- NVIDIA, “AVO Reaches 100 on ARC-AGI-3” (public-set result and caveats).
- NVIDIA, “Autonomous Variation Operator,” arXiv:2603.24517.
- AgenticOW/RVF source and ADR-202 dual-state branching.
