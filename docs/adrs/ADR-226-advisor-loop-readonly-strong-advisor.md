# ADR-226: Advisor-loop — strong-model read-only advisor over a cheap-model agentic harness

**Status:** Proposed — design + pre-registered benchmark plan; no code written yet (`advisor-loop.mjs` / `solve-advisor.mjs` are specified below, not built)
**Date:** 2026-07-02
**Related:** ADR-222 *(meta-llm repo — competing with Devin Fusion; this ADR inverts its Bet-3 sidekick)*, ADR-225 *(meta-llm, unmerged worktree — GLM-5.2 → Sonnet-5 → Fable-5 escalation ladder; roadmap, not landed)*, ADR-221 *(meta-llm, Accepted — availability-gated Fable-5 escalation)*, ADR-201 *(this repo — vector-memory cheap-model lift; H1/H5 nulls)*, ADR-205 *(this repo, `feat/darwin-handoff-adr205` branch — darwin harness-side ladder proof)*, ADR-216 *(meta-llm — calibrated escalation threshold, shadow-mode instrumented)*, `packages/darwin-mode/bench/swebench/{agentic-loop.mjs, fusion-loop.mjs, FUSION-BENCHMARK.md}`, cognition.com/blog/devin-fusion.

> **Numbering note.** This ADR continues the cross-repo 2xx decision thread: ADR-207–225 live in the meta-llm repo (`cognitum-one/meta-llm`, `docs/adr/`), and that repo's numbers **collide** with this repo's own ADR-204–206 (here: ADR-205 = darwin handoff, ADR-206 = BenchPress, both on branches; there: ADR-205 = free-trial Stripe, ADR-206/207 = pod/host layer). **226 is free in both repos.** Every cross-repo citation in this document is annotated with its repo; ADR-225 additionally exists only on an unmerged meta-llm worktree (`tier-pools-glm-sonnet-fable`) and is cited as roadmap, never as a landed result.

---

## 0. Executive summary

ADR-222's (meta-llm) fusion prototype put a **frontier lead inside the tool loop** and a cheap sidekick under it. The benchmark came back **INCONCLUSIVE at N=8** (0/8 gold-resolved in every arm) and exposed a dominating confound: the frontier **baseline arm (sonnet-5 solo, Arm A)** emitted **8/8 empty patches** because sonnet-5 does not reliably satisfy the harness's rigid single-line-JSON tool protocol. (The Arm C fusion lead produced 5/8 non-empty patches — the artifact bit the solo baseline hardest.) The frontier never got a fair shot; the cost win was real but uninterpretable.

This ADR proposes the **inversion**: the cheap model (deepseek-chat) runs the entire agentic loop and emits every tool action; the strong model (Sonnet-5) is a **read-only advisor** that never enters the tool protocol at all. It receives the problem + transcript + current diff as a single stateless completion and replies in **plain prose** — critique, root-cause check, next 1–3 concrete actions, and a pre-submit APPROVE/REVISE verdict. Because the strong model never emits a tool call, the tool-call-format confound is **structurally absent, not merely mitigated**.

The pattern has a production proof-of-concept: Claude Code's own harness ships an `advisor` tool — a stronger reviewer model consulted with the agent's full conversation transcript, returning guidance the working agent still executes itself. We are benchmarking that pattern, not inventing it.

Deliverables: `advisor-loop.mjs` (pure, dependency-injected, sibling of `fusion-loop.mjs`), `solve-advisor.mjs` wiring, `advisor-loop.test.mjs` ($0 mock tests), the committed slice manifest `advisor-medium-25.json`, this file at `docs/adrs/ADR-226-advisor-loop-readonly-strong-advisor.md` plus its `INDEX.md` row, and a screening benchmark whose centerpiece is the three-way **D vs D-self vs D0** — the same cheap loop with a frontier advisor, with a same-model placebo advisor, and with no advisor.

---

## 1. Context / problem

### 1.1 The ADR-222 fusion result (INCONCLUSIVE, N=8)

FUSION-BENCHMARK.md, gold-scored via `swebench.harness.run_evaluation` on an 8-instance hard slice (one per repo from `hard-25.json`), maxSteps 12, `--no-test-oracle`, concurrency 2:

| Arm | Config | Gold resolved | Non-empty patches | Total $ | $/inst |
|---|---|---|---|---|---|
| A | sonnet-5 solo, all steps | 0/8 | **0/8** | $1.073 | $0.134 |
| B | cascade deepseek → sonnet-5 | 0/8 | 5/8 | $1.184 | $0.148 |
| C | fusion (sonnet-5 lead + deepseek sidekick + routing) | 0/8 | 5/8 | $0.419 | $0.052 |

The cost cut is real (>Devin's published 35–41%) but "equal quality" is unprovable when every arm resolves 0/8 ("equally zero"). The dominating confound: **Arm A's 8/8 empty patches**. Sonnet-5 does not reliably emit "EXACTLY ONE JSON object on a single line" per turn, so its edits never land — reproducing the documented "custom harness under-scores frontier" lesson (step-cap + tool-call-format artifacts). B/C's non-empty patches exist because **deepseek does the actual editing**. Arm C telemetry confirms where the saving came from: 17 delegations but only 1 delegated edit landed; ~60% of *lead* steps routed cheap; sidekick was 6.8% of spend ($0.0286 of $0.419). The routed-cheap lead drove the saving — and the frontier-in-the-tool-loop premise drove the confound.

### 1.2 Why judgment, not mechanics, is the lever worth isolating

- **ADR-201 H5 (null, this repo)**: embedding-only difficulty routing is at chance (ROC-AUC 0.376 [0.230–0.534]); "difficulty is not linearly encoded in the query embedding." An accurate difficulty/judgment signal has to come from something that actually reads the trajectory — a strong model reviewing the transcript is that signal.
- **ADR-201 H1 (null, and a warning)**: small models fail to use even *oracle* context 85–100% of the time. So the advisor concept rests on an **unvalidated assumption** — that the cheap loop can *execute* correct advice. §4.8 pre-registers an oracle-advice invalidation probe for exactly this.
- **Devin Fusion's own framing** (quoted in ADR-222, meta-llm): the main agent "takes minimal actions… while making the significant decisions: the plan, the interpretation of ambiguity, the final review." Fusion keeps those decisions inside the tool protocol; the advisor-loop moves them **outside** it, where prose is a legal output format.

### 1.3 Relation to the escalation ladders (ADR-221 / ADR-225, meta-llm)

ADR-225's ladder (GLM-5.2 → Sonnet-5 → Fable-5) escalates by **swapping which model emits the next actions**, gated by a confidence proxy (τ = 0.6). Its headline — ~33% cheaper than all-Fable at 88% resolved, ~$0.97/resolved on gold-scored SWE-bench-Lite — is by ADR-225's own framing an **oracle projection** (perfect "did this tier fail?" signal); the ADR stamps itself PROPOSED/roadmap, the live gateway escalates on a confidence proxy, and confirmatory calibration (~62k-label floor) is open. Even granting the projection, at escalation the frontier still does the editing under the hostile JSON protocol. The advisor-loop is the orthogonal move: **never swap the actor; inject judgment as an observation**. ADR-221's availability-gated Fable-5 pattern carries over directly: the advisor model is availability-gated, degrades to a weaker advisor or to no-advisor (logged, never silently pooled).

ADR-222's Bet-3 caveat also carries over: a stateless completions gateway can't host agent-owned cached contexts, so the sidekick bet lives at the pod/host layer (ADR-206/207 — *meta-llm's* 206/207, NOT this repo's ADR-206 BenchPress). The advisor is *friendlier* to that constraint than the sidekick: it is a **single stateless completion over transcript+diff** — meterable and budget-capped through the gateway (ADR-203/204, meta-llm) with no persistent agent context at all.

### 1.4 Production proof-of-concept

Claude Code harnesses ship this exact shape in production: a working agent with an `advisor` tool that forwards the full conversation transcript to a stronger reviewer model, which replies with prose guidance the agent then executes itself (including "call it before declaring done" — the pre-submit review below). That is evidence the pattern is operationally sane; this ADR supplies the controlled measurement it has never had here.

---

## 2. Decision

Build **advisor-loop**: a variant of `agenticSolve` in which the cheap model emits every tool action and a strong model is consulted read-only via three bounded trigger paths — a voluntary `advise` tool, an involuntary checkpoint gate (same signals fusion used for escalation), and a mandatory pre-submit review with a bounded veto. Benchmark it as **Arm D vs a same-model placebo D-self vs a pure-cheap control D0** on the fusion hard-8 slice plus a new medium-25 slice, gold-scored, with a pre-registered decision table (§4). This is a **screening / effect-size-estimation run**, not a confirmatory one — consistent with ADR-222 §1's (meta-llm) "no hard-benchmark routing win exists to cite; don't bank the claim."

---

## 3. Architecture

### 3.1 Module plan

**NEW file `advisor-loop.mjs`** (same dir, sibling of `fusion-loop.mjs`), importing `{ makeTools, parseAction, stateHash, buildAgenticSystem }` from `./agentic-loop.mjs`. Do **not** extend `fusionSolve`: its control flow is the exact inverse (strong lead emitting actions, cheap sidekick executing). Advisor-loop has ONE actor emitting actions (cheap); the strong model never enters the tool protocol, so `makeRouter`/delegate/`runSidekick` machinery is dead weight — and threading options through `fusionSolve` would destabilize arm-C comparability (arm D must diff against a frozen arm C). Pure + dependency-injected, no fs/network, <500 lines, following the established pattern: loop here, real wiring in `solve-advisor.mjs`, mocks in `advisor-loop.test.mjs`. `agentic-loop.mjs` and `fusion-loop.mjs` are untouched.

Exports:

```js
export function buildAdvisedSystem(ext='py', glob='*.py')      // cheap-loop system prompt
export function buildAdvisorSystem(ext='py')                    // advisor system prompt
export function makeAdvisorGate(cfg={})                         // involuntary-checkpoint policy (mirrors makeRouter)
export function buildAdvisorPrompt({ problem, transcript, diff, phase, reason, question,
                                     maxChars=24000, diffChars=8000, obsChars=1200 })  // serialization, exported for tests
export async function advisorSolve({ problem, io, llmLow, llmAdvisor, gate, maxSteps=20,
  system, advisorSystem, tempSchedule, onStep, onAdvice,
  maxAdvisories=4, maxVetoes=2, adviceChars=1600, advisorMaxChars=24000 })
```

Both llms keep the existing contract `async (prompt, system, temp) => { raw, cost }`, so solve-fusion's `mkLlm` is reused verbatim. `llmAdvisor` is always called with `temp=0`. `llmAdvisor: null` runs the pure-cheap D0 mode: `buildAgenticSystem` (no advise line), no advisor calls, `advisorCost=0` — same wiring file, same code path otherwise (§4.1).

### 3.2 The `advise` tool (prompt surgery)

`buildAdvisedSystem` uses the exact `buildFusionSystem` idiom: `base.replace(submitLine, adviseLine + '\n' + submitLine)` where `submitLine = '{"tool":"submit"}                      finalize your patch and stop'` and the inserted line is:

```
{"tool":"advise","question":"<what you are unsure about — the plan, the root cause, or whether your fix is right>"}  consult your STRONG read-only advisor; it sees your full transcript + current diff and replies with guidance
```

Appended framing: *"You are a fast agent with a STRONG senior ADVISOR on call. The advisor cannot run tools or edit — it only critiques. Consult it when uncertain about the plan, the root cause, or fix correctness — never for mechanical steps you can just do. Its reply is guidance; YOU still choose and execute every action. Your final submit is automatically reviewed by the advisor."*

Note: this framing is shared by arms D and D-self (identical `buildAdvisedSystem`), so the D-vs-D-self comparison is clean on advisor-model identity; the D0 arm runs the unmodified `buildAgenticSystem` prompt, so D-self-vs-D0 bundles {prompt framing + checkpoint mechanism + injected critique text} — pre-registered reading in §4.2.

### 3.3 Advisor system prompt

`buildAdvisorSystem`: *"You are a READ-ONLY senior engineer reviewing an autonomous junior bug-fixing agent mid-task. You will receive: the problem statement, the agent's full action/observation transcript, the current working-tree diff, and a PHASE tag. You cannot execute tools or edit files, and you must NOT output JSON tool calls — reply in plain prose, ≤300 words: (1) is the diagnosis/root-cause right? (2) is the diff correct, minimal, non-test-touching? (3) the exact next 1–3 actions (file, line, what to change). Reference only files present in the transcript or diff. If PHASE is pre-submit, your FIRST line must be exactly `VERDICT: APPROVE` or `VERDICT: REVISE — <one-line reason>`."*

Free prose is the point: the frontier tool-call-format confound **structurally cannot occur** on this path.

### 3.4 Serialization + token bounds (`buildAdvisorPrompt`)

The advisor deliberately sees **more** than the loop's 12k-char sliding window (a designed asymmetry, stated up front):

1. Problem statement, 6000-char cap (same as the loop header).
2. FULL transcript replayed as `>>> actionRaw\nobs`, each obs re-capped to `obsChars=1200`; if the total exceeds `maxChars=24000`, keep the first 2 entries + tail entries with an `…[elided N steps]` marker (head anchors the plan, tail is current state).
3. `--- current diff ---` + `io.gitDiff()`, capped at `diffChars=8000` (head + truncation note).
4. `PHASE: consult | checkpoint(<reason>) | pre-submit`, and for voluntary consults `AGENT'S QUESTION: <question, 500-char cap>`.

Hard bound: ≤38,000 prompt chars ≈ **8–13k input tokens per call** (at 3–4 chars/token) — the number the cost model in §5 is derived from.

### 3.5 Three trigger paths

1. **Voluntary** — `action.tool === 'advise'`. If `advisories.length >= maxAdvisories`: obs = `advisor budget exhausted (${maxAdvisories}) — proceed with your best judgment`. Else consult; obs = `ADVISOR:\n${advice.slice(0,adviceChars)}\n(Guidance only — you execute the actions.)`
2. **Involuntary checkpoint** — `makeAdvisorGate({ adviseAfterFails=2, adviseOnThrash=true, cooldown=4 })`, closure state `{ advisedUntil, lastThrash }`, `decide({step, consecutiveTestFails, thrash}) → { consult, reason }` following `makeRouter`'s priority/edge-trigger semantics: suppressed while `step <= advisedUntil`; fails ≥ threshold → consult + set cooldown; `thrash > lastThrash` (new event only) → consult + cooldown; `_state()` exposed for tests. **Two deliberate deviations from `makeRouter`:** cooldown defaults to 4 (fusion's is 3) because an advisor call costs more than one escalated cheap step, so the suppression window is one step longer; and `leadSteps` has no advisor analogue by design — the opening plan stays cheap. The gate runs AFTER the normal tool obs is computed — the loop tracks `consecutiveTestFails` exactly as fusionSolve does (reset on `/ALL TARGET TESTS PASS/`, increment on failing run_tests unless `/no edits applied yet/`) and thrash via the read/grep/ls `stateHash` repeat rule. On consult, APPEND to the obs: `\n📋 ADVISOR (checkpoint: repeated-test-fail(2)):\n<advice>`. This replaces fusion's escalate-to-high — **same signals, judgment injection instead of model swap**. Checkpoint consults count against `maxAdvisories`.
3. **Mandatory pre-submit veto** — on `submit` with non-empty `io.gitDiff()` and `vetoes < maxVetoes` → consult with phase `pre-submit` (NOT counted in `maxAdvisories`). Parse `/^\s*VERDICT:\s*APPROVE/i` on the first line → `submitted=true`. Otherwise `vetoes++`, **the vetoed diff is snapshotted** (`vetoedPatches.push({step, diff: io.gitDiff()})` — required by §4.7's counterfactual scoring), loop continues, obs = `submit VETOED by advisor (${vetoes}/${maxVetoes}):\n<advice>\nAddress this, run_tests, then submit again.` Bounds: once `vetoes === maxVetoes`, subsequent submits pass unreviewed (no infinite veto loop); empty-diff submit skips review entirely. An unparseable verdict defaults to APPROVE (fail-open — resolve rate before cost, per ADR-225's (meta-llm) acceptance ordering).

**Step accounting (pre-registered, §4.6):** `advise` and a vetoed `submit` are ordinary transcript entries counted against `maxSteps`; no extra loop steps are granted. D's extra LLM calls are the advisor calls themselves — hard-capped at `maxAdvisories + maxVetoes + 1 = 7` per instance.

### 3.6 Robustness + return shape

Advisor errors are **non-fatal** (unlike `llmLow` errors, which break the loop as today): catch → obs `(advisor unavailable: <msg>)`, continue; a pre-submit failure counts as APPROVE. This matters because the strong model is availability-gated (ADR-221, meta-llm).

Return: `{ patch, steps, submitted, resolvedInLoop, cost: loopCost+advisorCost, loopCost, advisorCost, advisories: [{step, trigger:'advise'|'checkpoint'|'pre-submit', reason, question?, verdict?, promptChars, cost, advice: advice.slice(0,400)}], vetoes, vetoedPatches, executorActions, thrash, transcript }`. `executorActions` = count of non-advise, non-vetoed-submit actions (required by §4.6's step-budget disambiguation). `onAdvice(step, trigger, advice)` hook mirrors `onStep`.

### 3.7 Real wiring: `solve-advisor.mjs`

Mirrors `solve-fusion.mjs` (fetchRepo, mkLlm, applyEdit, langProfile io, conformant test oracle, worker-pool concurrency, `--max-cost` budget cap). Knobs: `--model deepseek/deepseek-chat` (loop), `--advisor-model anthropic/claude-sonnet-5 | deepseek/deepseek-chat | none`, `--advise-after-fails 2`, `--advisor-cooldown 4`, `--max-advisories 4`, `--max-vetoes 2`, `--advisor-max-chars 24000`, plus standard `--manifest/--max-steps/--no-test-oracle/--max-cost/--cheb-temp/--concurrency`. `--advisor-model none` = D0 (same wiring file and code path as D — no separate-harness drift; §4.1). Every LLM call logs the **actual provider + model id returned by OpenRouter** into the report JSON so cross-run model-snapshot drift is flagged rather than assumed away (§4.4).

Report JSON: `{ mode:'advisor', model, advisorModel, ..., loopCost_usd, advisorCost_usd, advisorCostFraction, totalAdvisories, advisoriesByTrigger, totalVetoes, avgAdvisorCallsPerInst, executorActionsPerInst, vetoedPatches }` plus the standard resolve/conformance fields. `vetoedPatches` are gold-scored alongside final patches (§4.7).

### 3.8 $0 test plan (test contract, `advisor-loop.test.mjs`)

Reuse `makeFakeIo` + `scripted(responses, label)` from `fusion-loop.test.mjs` (queue exhaustion throws → loop overrun is an explicit failure). Tests: (1) voluntary advise injects `ADVISOR:` obs, advisorCost accrues, `cost === loopCost + advisorCost` to 1e-9; (2) gate edge-trigger + cooldown via `_state()`; (3) veto→fix→approve: scripted advisor `['VERDICT: REVISE — x','VERDICT: APPROVE']`, assert `vetoes===1`, `submitted===true`, `vetoedPatches.length===1` with the pre-fix diff; (4) always-REVISE advisor still submits after `maxVetoes`; (5) advisor throw is non-fatal, loop continues; (6) `buildAdvisorPrompt` contains the diff + early transcript entries beyond the 12k loop window + the elision marker, and never exceeds 38k chars; (7) `buildAdvisedSystem` matches `/"tool":"advise"/`, `buildAdvisorSystem` does not; (8) `maxAdvisories` exhaustion obs; (9) `io._setTestsPass` mid-run flip for checkpoint-then-resolve; (10) `llmAdvisor: null` (D0 mode) uses `buildAgenticSystem`, makes zero advisor calls, `advisorCost===0`, `executorActions===steps`.

---

## 4. Benchmark plan (pre-registered)

### 4.1 Arms

- **Reuse** A (frontier solo), B (cascade), C (fusion) hard-8 gold numbers from FUSION-BENCHMARK.md as-is — same slice, same conformance rules. Do NOT rerun A: it only reproduces the documented empty-patch artifact at frontier prices. Do NOT substitute ADR-225 (meta-llm) ladder numbers as a cascade baseline — those are solve-repair (a different harness), not agentic-loop-comparable. Caveat logged, not hand-waved: A/B/C were run weeks earlier and `deepseek-chat`/`claude-sonnet-5` are provider-side aliases, so strict same-model comparability with the reused numbers is **assumed, flagged, and checked** against the per-call provider/model-id logs (§3.7), not claimed as identity.
- **NEW D0 = pure cheap loop, advisor disabled** (deepseek-chat, `--advisor-model none` through `solve-advisor.mjs` — same wiring/temp/fetchRepo code path as D, unmodified `buildAgenticSystem` prompt). D0 does not exist in prior data — no arm ever ran cheap-solo. **D0 is the baseline control.**
- **NEW D-self = placebo advisor** (deepseek-chat advising itself): identical `buildAdvisedSystem` prompt, identical triggers, identical injection format — only the advisor model differs from D. Near-$0 (<$0.01/call). **D-self is what makes D interpretable**: Reflexion-style self-critique alone is known to lift agent performance, so without it a D-vs-D0 lift cannot distinguish "strong-model judgment helps" from "any mid-loop critique text helps."
- **NEW D = the same cheap loop + read-only frontier advisor**, all three triggers on. **Advisor model pinned: `anthropic/claude-sonnet-5`.** A Fable-5 advisor variant (D-F) is explicitly deferred to a follow-up gated on D's screening outcome AND a measured prompt-cache hit rate (§5) — it gets no arm, no budget line, and no post-hoc substitution in this run.
- Run D0+D-self+D on hard-8; run D0+D-self+D+B(rerun) on medium-25.

### 4.2 Why the three-way comparison is the centerpiece

D and D-self differ **only in who advises** (frontier vs the cheap model itself); D-self and D0 differ in the checkpoint mechanism + prompt framing + injected critique text. The frontier never emits tool actions in any arm, so the tool-call-format confound is structurally absent everywhere. Pre-registered reading:

- **D > D-self > D0** → strong-model judgment is the lever (the hypothesis).
- **D ≈ D-self > D0** → the checkpoint/reflection *mechanism* is the lever, not the model — adopt D-self (near-free) and kill the frontier-advisor spend.
- **D ≈ D-self ≈ D0** → mid-loop critique doesn't move this executor at all (see kill criteria).

A-vs-C confounded protocol compliance with capability (A's 8/8 empty patches). B-vs-D still confounds frontier judgment with frontier mechanics — at cascade escalation the frontier edits under the hostile protocol. D-vs-B remains the secondary cost-relevance comparison; **D-vs-D-self-vs-D0 is the causal chain**.

### 4.3 Slices + N (power-honest), with the literal selection rule

- **Hard-8** (fusion slice, unchanged): kept only for A/B/C comparability and the binary signal "did D convert ANY hard instance" (any >0 is notable). At 0/8 floors it has zero discriminating power on its own.
- **Medium-25 — literal pre-registered rule (executed before any arm runs, manifest committed as `bench/swebench/advisor-medium-25.json`):** candidates = instances in `full-300.json` whose `instance_id` is in neither `fusion-hard-slice.json` nor `hard-25.json`; sort by `instance_id` ascending; take in order subject to a max-2-per-repo cap until 25 are selected. No seed, no report-JSON-derived filtering — prior-outcome selection was considered and **rejected** because picking sometimes-solved instances guarantees regression to the mean and imports cross-harness drift.
- **Baseline-band contingency (pre-registered):** run and gold-score **D0 first**. If D0 resolve lands outside [10%, 55%] (i.e. outside 3–13 of 25), the slice is declared invalid for discrimination, a replacement slice is drawn by the same rule from the remaining candidates, and D0 reruns — all **before** any D or D-self result is looked at. Both slices and both D0 scores are reported if this fires.
- Honesty: at N=25/arm only ~+35pp clears p<0.05; ADR-225's (meta-llm) ~62k-label floor puts confirmatory testing out of scope. This is explicitly a **screening / effect-size-estimation run** that decides whether to fund a larger one. One run per arm; D/D-self/D0 are paired on identical instances and discordant-pair counts (McNemar-style) are reported descriptively, not tested.

### 4.4 Protocol constants (all fixed now)

Same as the fusion benchmark: **maxSteps 12** (protocol override of `advisorSolve`'s code default 20 — stated here so the two never blur), concurrency 2, `--no-test-oracle` (in-loop signal = repo's own tests inside the instance image), gold Docker scoring for all headlines, **no chebTemp — temp 0 for every loop and advisor call in every arm**, same manifest order across arms, one run per arm. Per-arm `--max-cost`: 12 for D0/D-self/B(rerun), **15 for D-medium** — §4.5's worst case (~$12) would otherwise sit exactly at the cap, and mid-run budget truncation censors instances not-at-random (late-manifest instances silently dropped). **Pre-registered: if any arm hits its `--max-cost` before completing its manifest, that arm is invalid and rerun with a raised cap — partial arms are never reported as complete.** Per-call provider/model-id logging per §3.7.

### 4.5 Budget (derived from observed anchors + §3.4's token bound)

- **D0** ≈ **$0.03–0.08/inst** (single estimate; INFERRED, never measured — nearest anchors: C's ~60%-cheap-routed lead at $0.052/inst all-in, B's $0.148) → hard-8 <$1, medium-25 ~$1–2.
- **D-self** ≈ D0 + ~$0.02/inst (placebo advisor calls are cheap-model priced) → ~$1–2.5 medium-25.
- **Advisor call (Sonnet-5)**: 8–13k tok in + 0.5–1k out (§3.4). At intro pricing $2/$10 per Mtok (in effect through 2026-08-31, the price for this run): **$0.02–0.04/call**; at sticker $3/$15: $0.03–0.055/call. Durable-document note: all Sonnet math below uses intro pricing and shifts ~+50% at sticker.
- **D advisorCost**: expected (2–4 calls/inst, the hypothesis) = **$0.04–0.16/inst**; hard-cap worst case (7 calls: 4 advisories + 2 vetoes + 1 pre-submit) = **≤$0.28/inst**. Budgeting uses the worst case; the 2–4 range is a telemetry check, not a budget input.
- **D total**: expected **$0.07–0.24/inst**, worst ≈$0.36/inst → medium-25 expected $2–6, worst ≈$9; hard-8 ≤$3.
- **B rerun** medium-25 ≈ 25 × $0.148 ≈ $3.7.
- **Total new spend ≈ $10–18 expected, ≤$25 hard ceiling** across both slices and all new arms.
- (For reference, NOT budgeted: a Fable-5 advisor at $10/$50 per Mtok is $0.10–0.18/call — ≈5× Sonnet intro, ≈3.3× Sonnet sticker — i.e. worst-case ≈$1.26/inst advisor spend; this is why D-F is deferred, §4.1/§5.)

### 4.6 Pre-registered confound decisions

1. **Step accounting**: `advise` consumes a loop step; vetoed submits consume steps; pre-submit review grants no extra steps and vetoes are capped at 2 — D never gets a longer loop than D0 in steps, only bounded extra advisor calls (the treatment itself). **The flip side is pre-registered too**: at maxSteps 12, up to 6 of D's 12 steps can be consumed by advise/vetoed-submit entries, so a null could mean "judgment strangled by a halved executor budget," not "judgment worthless." Both `executorActions` per instance (§3.6) are reported for every arm, and kill-1 has an executor-budget escape hatch (§4.8).
2. **Window eviction**: the loop's transcript replay is `.slice(-12000)` (~3 full 4k observations). An uncapped advisor critique injected as an observation would evict 1–2 tool observations — D vs D0 would then differ in effective memory, not judgment. Advisor observations are capped at `adviceChars=1600` (mirroring the bounded sidekick-result format) and truncation is reported. The full-transcript-to-advisor vs windowed-loop asymmetry is deliberate design, stated in §3.4.
3. **Residual prompt-framing confound**: D0 runs the unmodified prompt while D/D-self run `buildAdvisedSystem`. This is deliberate (D0 = "the loop as it exists today") and is exactly why D-self exists: the D-vs-D-self comparison holds the framing constant. The D-self-vs-D0 delta is reported as {mechanism + framing} jointly, never attributed to either alone.
4. All other routine constants matched per §4.4.

### 4.7 Success criteria (screening bar) + counterfactual veto scoring

Primary (medium-25, paired):

1. **D ≥ D0 + 12pp** (≥3 instances), AND
2. **D ≥ D-self + 8pp** (≥2 instances) — the strong model must beat its own placebo, AND
3. **D $/resolved ≤ B(rerun) $/resolved.** Deliberately `$/resolved`, not `$/inst`: §4.5's own arithmetic says D's expected $/inst ($0.07–0.24) straddles-to-exceeds B's ($0.148), so a naive $/inst bar would be pre-registered to fail; the economic claim being screened is *judgment lift per dollar*, and no prompt-caching discount is assumed anywhere in the bar.

Secondary: any hard-8 conversion by D; **veto value, measured counterfactually**: every vetoed patch is persisted (§3.5) and gold-scored in the same `run_evaluation` batch as the final patches. `vetoSaved` = vetoed patch fails gold AND final patch resolves gold; `vetoHarmed` = vetoed patch resolves gold AND final patch fails gold. Secondary success = ≥1 `vetoSaved` with `vetoHarmed = 0`.

### 4.8 Kill criteria + decision table

Kill criteria (medium-25 unless stated):

1. **D ≤ D0** — with the escape hatch: if median `executorActions(D)` < median `executorActions(D0)` − 2, the null is confounded by step starvation; run one D variant at maxSteps 16 (executor-matched) before kill-1 may be declared.
2. **D $/resolved > B(rerun) $/resolved while D's resolve count is within 1 instance of B's** — paying frontier-advisor prices for cascade-grade results.
3. **Veto lever dead**: across both slices, either no veto ever fires, or ≥3 vetoes fire with `vetoSaved = 0` (measured per §4.7's gold-scored vetoed patches — now decidable from telemetry). Kills the *mandatory* pre-submit review (demoted to config-off), not the whole concept.

**Oracle-advice invalidation probe (ADR-201 H1 precedent):** a **D-oracle arm** — hand-written correct advice injected at the same trigger timing as D's checkpoints. Conformance rules: the advice is derived from gold patches, so the arm sets the leakage flag, is excluded from every `leaderboardConformant` headline, and its advice is written per-instance **before unblinding any D/D-self medium-slice result** (advice tuned to observed failures would bias the very execution-capability estimate the probe exists to make). If D-oracle fails to lift cheap resolve, judgment is not the binding constraint — execution is — and the concept is dead regardless of advisor quality.

**Decision table (pre-registered — partitions the outcome space):**

| Medium-25 outcome | Reading | Action |
|---|---|---|
| D ≥ D0+12pp AND D ≥ D-self+8pp AND $/resolved ≤ B | Strong-judgment lift, economically sane | **Success** — fund confirmatory run (N≥100), consider D-F follow-up |
| D ≥ D0+12pp but D < D-self+8pp | Mechanism/reflection is the lever, not the model | Adopt D-self (near-free), kill frontier-advisor spend |
| Lift criteria met but $/resolved > B | Judgment works, economics don't | Iterate cost side only (fewer triggers, caching redesign per §5) — no rerun of the causal question |
| 0 < D−D0 < 12pp (1–2 instances) | Underpowered middle — most likely region | One `-r2` rerun of D/D0 only; if the sign holds, treat as fund-larger; **no lift claim banked either way** |
| D ≤ D0, executor-actions comparable | Judgment worthless here | **Kill-1** |
| D ≤ D0, D executor-starved (>2 median gap) | Confounded null | maxSteps-16 D variant, then re-enter this table |
| D-oracle fails to lift | Execution-bound (ADR-201 H1 confirmed) | **Concept dead** regardless of other rows |

Hard-slice gold resolve staying 0 across all arms is *unmeasurable, not falsified* — change slice, don't claim. Per ADR-201's (this repo) "report whichever way it lands" integrity clause — and ADR-216's (meta-llm) shadow-mode pattern of instrumenting before trusting — a null is reported as a null.

**Residual threat to validity (pre-registered check, not a criterion):** SWE-bench gold patches are public training data; a frontier advisor may *recall* a fix rather than *judge* the trajectory. Stored advice excerpts are scanned for gold-patch hunks/identifiers not derivable from the transcript+diff shown, and the match count is reported next to the lift. Memorized advice doesn't violate `--no-test-oracle` mechanically, but it caps how far any measured lift generalizes off-benchmark.

---

## 5. Cost model

- Per-call input = problem (≤6k chars) + re-capped transcript (≤24k chars) + diff (≤8k chars) = ≤38k chars ≈ **8–13k input tokens**; output short (0.5–1k tok prose).
- Per-call price: Sonnet-5 **$0.02–0.04 (intro $2/$10, through 2026-08-31 — the price in effect for this run; $0.03–0.055 at $3/$15 sticker)**; Fable-5 ($10/$50) **$0.10–0.18**. Expected 2–4 calls/inst (hypothesis, checked in telemetry); hard cap 7.
- Anchors (fusion N=8 hard, gold-scored): C $0.052/inst; B $0.148; A $0.134 — but A bought 8/8 EMPTY patches, so it is confounded as both a cost and a quality bar; do NOT breakeven against it naively. D0 est. $0.03–0.08/inst (**INFERRED, never run** — nearest measured anchor is Arm C with ~60% cheap lead steps).
- Headline risk, recomputed: cheap loop + 3 Fable-5 advisor calls ≈ **$0.35–0.62/inst** — roughly **7–12× arm C** ($0.052/inst) and 2.4–4.2× arm B. That is why the Fable advisor gets no arm in this run.
- **Prompt caching is NOT banked, and the reason is structural, not just prudential**: (a) §3.4's elision scheme rewrites the middle of the serialized transcript once it exceeds 24k chars, so consecutive advisor calls share a prefix only up to problem+head — the "growing append-only prefix" premise fails under this serialization; (b) advisor calls are separated by multiple loop steps including up-to-420s Docker test runs, past Anthropic's ~5-minute default cache TTL. A D-F follow-up therefore requires BOTH an append-only serialization redesign (no mid-elision; overflow dropped into a trailing uncached block) AND a measured cache hit rate through OpenRouter as a gating check. Until then, Fable-advisor economics are evaluated at full price.
- Breakeven definition: advisorCost/inst < resolve-rate lift × cost-per-resolved delta vs the best non-advisor arm at equal quality. Unmeasurable on a 0-resolve slice — hence the medium slice (fusion lesson #3). The pre-registered form of this is §4.7's `$/resolved ≤ B(rerun)` bar.
- The mandatory pre-submit review is ≥1 frontier call on EVERY instance with a non-empty diff, including easy ones the cheap model already solves — a pure tax on the easy regime where the cheapest tier is already Pareto-optimal (ADR-222, meta-llm, §2's easy-regime observation). Mitigation options (config, not default-on for arm D): skip review when tests pass with zero thrash, or sample it.

---

## 6. Failure modes → mitigations

| # | Failure mode | Mitigation |
|---|---|---|
| 1 | Cheap loop ignores advice — advice enters as an observation inside the 12k-char window and scrolls out in ~3 steps | Track "advice adherence" telemetry (do the next-k actions touch advised files?); follow-ups if warranted: pin latest guidance in the header (outside the slice), require an acknowledgment action |
| 2 | Advice too abstract to execute (ADR-201 H1: small models fail to use even oracle context 85–100%) | Advisor output constrained: numbered concrete next actions with file:line refs, ≤300 words; D-oracle probe (§4.8) decides whether execution is the binding constraint |
| 3 | Pre-submit veto loops — veto→work→veto burns both budgets | `maxVetoes=2` then accept-with-note; `maxAdvisories=4` hard cap; veto must cite a diff-level objection; advisorCost inside `--max-cost` |
| 4 | Advisor hallucinates file names — it never reads the repo, only transcript+diff | Instruct "reference only files present in the transcript or diff" (§3.3); harness existence-checks named paths ($0) and annotates |
| 5 | Coverage bias + truncation — advisor only sees what the cheap model chose to read, at capped obs; the buggy file may never appear | Attach current diff + last failing logTail at generous caps; accept the advisor can only redirect search, not see the repo |
| 6 | Latency — one extra serial frontier call per checkpoint | Neutral vs 420s Docker test runs |
| 7 | Correlated failures (ADR-225 E5/E6, meta-llm): advisor and cheap loop fail on the same hard instances; lift smaller than hoped | Pre-registered kill criteria + decision table; effect size reported honestly |
| 8 | Advisor outage (ADR-221 gating, meta-llm) | Non-fatal by construction (§3.6); degrade to weaker advisor or skip; a degenerated arm is logged, never silently pooled |
| 9 | Advisor memorization of public gold patches masquerading as judgment | Pre-registered contamination scan of stored advice excerpts (§4.8); reported next to lift |

---

## 7. Alternatives considered

1. **Router-escalation inside the loop (as ADR-222 arm C / ADR-225 ladder, both meta-llm)** — rejected as the *primary* lever here: at escalation the frontier emits tool actions and hits the tool-call-format artifact (arm A: 8/8 empty patches); ADR-201 H5 (this repo) shows cheap difficulty classifiers are at chance; and ADR-225's live calibration needs ~62k labels. The ladder remains the shipped production mechanism; this ADR tests the orthogonal one.
2. **Tier cascade (arm B)** — measured: 0/8 at $0.148/inst; the escalated tail still puts the frontier under the hostile protocol. Kept as the secondary cost comparison, not the design.
3. **Frontier-only loop (arm A)** — measured: $1.073 for 8/8 empty patches. Rerunning it only reproduces the artifact at frontier prices until the harness gains a native tool-calling protocol (FUSION-BENCHMARK next-step #2 — separate work).
4. **Judge-panel post-hoc** (score/select finished patches, no mid-loop feedback) — rejected: it can only reject, never redirect; with cheap-solo resolve near the floor on hard slices there is nothing to select among; and it forfeits the checkpoint trigger, which is where fusion's escalation signals (consecutive fails, thrash) say judgment is needed *mid-trajectory*.
5. **Extending `fusionSolve` with an advisor flag** — rejected (§3.1): inverse control flow, dead machinery, and it would unfreeze arm C's comparability.
6. **Prior-outcome-based medium slice** — rejected (§4.3): regression to the mean + cross-harness drift; replaced by a mechanical rule + D0-first band contingency.

---

## 8. Conformance / security notes

- **Oracle isolation extends to the advisor.** Under `--no-test-oracle`, the advisor prompt is built SOLELY from problem + transcript + diff; gold FAIL_TO_PASS or oracle logTail reaching the advisor voids `leaderboardConformant`. This is asserted **in code** (`buildAdvisorPrompt` takes only transcript/diff/problem inputs; `solve-advisor` sets the leakage flag exactly as `solve-fusion` does), not left as convention.
- **The D-oracle probe arm is non-conformant by construction** (advice derived from gold patches): leakage flag set, excluded from every conformant headline, advice authored before unblinding (§4.8).
- Repo-content → transcript → advisor-prompt is the same prompt-injection surface as the base loop; the advisor adds **no new trust boundary** (read-only, no tools, its output re-enters as a bounded observation).
- Fable-5 availability gating per ADR-221 (meta-llm): probe-down degrades the advisor or skips; the degenerate run is logged, not pooled.
- advisorCost is a third metered bucket feeding `--max-cost` and the report JSON — compatible with gateway metering/receipts (ADR-203/204, meta-llm) since each advisor call is a single stateless completion.

---

## 9. Consequences

### Positive
- Frontier judgment at a bounded 2–4 (cap 7) calls per instance; the frontier path **never touches the tool-call-format confound**.
- D-vs-D-self-vs-D0 gives the series its first clean causal chain for "does strong-model judgment lift a cheap executor" — separating the model from the mechanism, which ADR-222's (meta-llm) arms could not do.
- The advisor is a single stateless completion over transcript+diff — meterable/budgetable through the gateway (ADR-203/204, meta-llm) with no agent-owned cached context, unlike ADR-222 Bet-3's sidekick; the loop itself stays at the pod/host layer (ADR-206/207, meta-llm).
- Vetoed-patch gold-scoring makes the review lever's value *measured*, not asserted.
- Reuses frozen primitives (`agentic-loop.mjs` untouched, `mkLlm` verbatim, fusion test idioms), so the marginal code and test surface is small.

### Negative
- Full-transcript input makes calls expensive — a Fable-5 advisor is 7–12× arm C's whole per-instance cost at 3 calls, and the prompt-caching rescue fails structurally under the current serialization (§5); D's expected $/inst likely exceeds cascade's, which is why the success bar is $/resolved.
- New failure mode class (veto loops), bounded but real.
- Efficacy rests on the unvalidated assumption that cheap models can execute correct advice (ADR-201 H1 is the warning; §4.8 pre-registers the D-oracle kill probe).
- Attribution of advisor value is indirect — only visible via downstream cheap execution and counterfactual veto scoring, never directly in the patch.

### Neutral
- Cheap-loop mechanics unchanged (same tools, window, anti-thrash; temp 0 everywhere this run).
- Conformance unchanged provided oracle isolation holds; the deliberately non-conformant D-oracle probe is quarantined from headlines.
- Any savings remain slice-dependent (ADR-225, meta-llm): all-hard workloads may degenerate — for the advisor, to "paying a review tax on unresolvable instances."

---

## 10. References

- ADR-222 *(meta-llm — competing with Devin Fusion)*: Bet 3 (pod-layer sidekick) is the delegation this ADR inverts; §4 falsifiable "beat" bar honored (no equal-quality claim will be banked from a screening run); §2 easy-regime Pareto observation cited in §5.
- ADR-225 *(meta-llm, unmerged worktree `tier-pools-glm-sonnet-fable` — PROPOSED/roadmap)*: escalation-ladder terminology, oracle-projection caveat, correlated-failure + slice-dependence + ~62k-label caveats, resolve-before-cost acceptance ordering.
- ADR-221 *(meta-llm — Accepted)*: availability-gated Fable-5; the advisor's degradation policy.
- ADR-216 *(meta-llm — calibrated escalation threshold, shadow-mode instrumented)*: cited for the shadow-mode instrument-before-trusting pattern only.
- ADR-201 *(this repo)*: H1/H5 nulls motivating judgment-injection over embedding routing; the oracle-context invalidation precedent; the "report whichever way it lands" integrity clause.
- ADR-205 *(this repo, `feat/darwin-handoff-adr205` branch — distinct from meta-llm's ADR-205)*: darwin harness-side ladder proof.
- `packages/darwin-mode/bench/swebench/fusion-loop.mjs`, `fusion-loop.test.mjs`, `solve-fusion.mjs` — the composition/mocking/wiring patterns reused.
- `packages/darwin-mode/bench/swebench/FUSION-BENCHMARK.md` — arms A/B/C protocol + gold numbers + the stated confound.
- `packages/darwin-mode/bench/swebench/{full-300.json, hard-25.json, fusion-hard-slice.json}` — the manifests §4.3's selection rule operates on.
- https://cognition.com/blog/devin-fusion — primary source for the Fusion mechanisms and 35–41% cost claims (their numbers, quoted as theirs).
