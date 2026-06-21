# ADR-167: Real-LLM defensive discovery harness, escalation router, self-learning loop, and open-frontier model selection

**Status**: Proposed — reference implementation in `@metaharness/projects`
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-DISCOVER`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: Defensive, execution-verified vulnerability discovery on **owned or authorized** code, with a real-LLM escalation lane
**Related**: ADR-155 (Darwin Shield), ADR-156 (borrowed-pattern program — mutate structured policies, not prompts), ADR-157 (checkpoints), ADR-158 (trace/cost ledger), ADR-160 (escalation scheduler), ADR-161 (ruVector memory tiers), ADR-162 (dataset registry), ADR-163 (typed handoffs), ADR-164 (safety rails), ADR-165 (opportunity scanner), ADR-166 (human review gates)

> This ADR records decisions that EMERGED while implementing the ADR-156 program with a real model in the loop (via OpenRouter), not from a prior spec. It is recorded under the repo's sequential numbering (never renumber). It stays inside the ADR-155 invariants: **defensive only** (`exploitCodeAllowed = false`, scope = owned/authorized), the model is frozen, the harness evolves, and the proof is in replay.

## Context

The borrowed-pattern modules (ADR-157…166) gave us a real, dependency-free harness, but everything was scored by *synthetic* oracles. With a working OpenRouter key we put a **real model in the loop** for the first time and had to decide: how to use a frontier model for discovery *without* (a) generating exploits, (b) trusting model hallucinations, or (c) overspending. Three decisions and one empirical question fell out, all now implemented and measured (receipts in `packages/projects/bench/results/`).

The framing is post-**Claude Mythos** (an unreleased, *offensive*, frontier-emergent zero-day model): we are **not** competing on offensive capability. We compete on the **defensive** axis — precision and **cost-per-verified-finding** on real code — where the deployed SOTA is static analyzers + human triage.

## Decision

### 1. Execution-verified defensive discovery harness (`src/discovery.ts`)
Pipeline: **cheap static + LLM triage → frontier LLM proposes a concrete PROOF input → execution VERIFIES it → only execution-confirmed (or tool-confirmed) weaknesses are reported.** The verifier is the **anti-hallucination spine**: an LLM claim with no working proof is discarded. Strictly defensive — we demonstrate a weakness *exists* (a crash / injection site) and emit only the exception **class** or CWE; **proof inputs are redacted, never emitted**. A `severityOf()` heuristic ranks a bare `TypeError` (wrong-type misuse, trivially reachable) below genuine edge-case faults.

### 2. Escalation router (`src/router.ts`) — frontier only when it earns its cost
`classify` routes a task to the cheap or frontier lane (size/risk/value/long-horizon); `runWithEscalation` runs cheap → verify → escalate to frontier only on a verify failure. The product metric is **cost-per-verified-finding**, attributed via the ADR-158 cost ledger.

### 3. Self-learning loop (`src/learning-loop.ts`) backed by metaharness memory
`runLearningLoop` escalates **once** to learn a generalized proof *cue* for a weakness class, stores it in the **real `TieredMemory`** (ADR-161, `mutation` tier), and the cheap lane reuses it on later same-class targets — **escalate-once-to-learn, then cheap-forever**. Cues are generalized (not payloads).

### 4. Open-frontier model selection (`src/openrouter.ts` + bake-off)
The frontier lane is a **configurable open/Chinese model**, chosen by an empirical bake-off, not by brand. The OpenRouter client is optional/key-gated, reads the key from the environment only (never logged), and enforces a hard request cap. **Recommendation: default the frontier lane to `qwen/qwen3-235b-a22b-2507`** (best verified-per-cost in the bake-off), with GLM-5.2 / DeepSeek-v3.2 configurable. Open + MIT-class models keep the deployment sovereign and auditable.

## Empirical results (real, key-gated; single non-deterministic runs unless noted)

- **Discrimination on real code** (`real-corpus-scan.json`): 147 real files (flask/jinja2/paramiko/requests/…) + 3 planted exploitable vulns → 9 raw semgrep findings → GLM-5.2 triage **KEPT all 3 real vulns (HIGH) and SUPPRESSED all 6 by-design FPs** (jinja2/flask `exec`, RFC-mandated md5, PYTHONSTARTUP). **Precision 3/3, recall 3/3, ~$0.0085.** This is the precision win over raw-SAST SOTA, and it disproves "rubber-stamp."
- **Frontier earns its cost on hard tasks** (`proposer-bakeoff.json`): cheap (qwen-7b) 3/6 vs GLM-5.2 6/6 — escalation recovered the cases the cheap model missed (~half the frontier-only cost). On *easy* tasks the cheap model matched the frontier, so escalation is value-gated by difficulty.
- **Open-frontier bake-off** (`chinese-frontier-bakeoff.json`): on 6 hard bugs, **`qwen3-235b-a22b-2507` 6/6 @ 0.019 mUSD/verified** and **deepseek-v3.2 6/6 @ 0.051** both BEAT **glm-5.2 (5/6 @ 0.914)** — better recall at ~18–47× lower cost. (minimax-m2.5 / glm-4.7-flash 0/6 — likely output-format/provider issue, flagged, not trusted.)
- **Multi-seed gate** (`frontier-multiseed.json`, 6 funcs × 4 seeds = 24 cells, temp 0.8): **Qwen3-235B verified-rate 0.875 vs GLM-5.2 0.708** at **~72× lower cost/verified** (0.016 vs 1.18 mUSD); paired bootstrap (qwen−glm) meanDelta +0.167, **lower95 = 0, p≈0.06**. Honest verdict: Qwen3-235B is **not statistically worse** than GLM-5.2 and far cheaper — the swap is justified on cost with no recall penalty, **not** a significant capability win. **Decision: default frontier lane → `qwen/qwen3-235b-a22b-2507`** (`DEFAULT_FRONTIER_MODEL`); re-run discovery (5 distinct vuln sites unchanged) and escalation (frontier-only cost-per-passing dropped ~36× vs GLM) confirm the harness behaves on the new default.
- **Self-learning** (`learning-loop.json`): memory ON (router + TieredMemory) → 6/6 verified, **0 escalations, 95.7% cost reduction** vs memory OFF (5/6, 2 escalations) — BUT this was a single run on a *favorable* single-class corpus.
- **Self-learning, larger + gated** (`learning-loop-large.json`, 17 targets / 6 classes / 3 seeds): the sober, statistically-gated picture. Both arms verify 17/17 (escalation already catches everything → memory does not change recall). Memory ON cuts frontier **escalations from 1.67 → 0.33 per run** — paired bootstrap escalations-avoided meanDelta 1.33, **lower95 = 1, p = 0** (significant). Cost reduction is **~18% with the cheap default frontier** but **~60% projected with an expensive (GLM-5.2) frontier** — i.e. the loop reliably saves frontier *calls*; the dollar saving scales with frontier price, and the 95.7% headline does NOT generalize to a diverse corpus.

## Consequences

**What changes.** Discovery has a real, cost-disciplined, execution-verified LLM lane with a configurable open-frontier model; the harness can learn across targets; the metric is cost-per-verified-finding.

**What does not change.** Defensive-only invariants hold (no exploit output; proofs redacted; owned/authorized scope). The model stays frozen. The deterministic test suite stays free and reproducible — all real-LLM benches are optional, key-gated, and excluded from `run-all`.

**What hurts.** Cross-model results are **single non-deterministic runs** — directional, not statistically gated; production model selection must be confirmed with multi-seed + bootstrap. The corpora are small (toy fixtures + a few real packages + planted vulns); findings are robustness/CWE-class, **not novel zero-days**. This is **not Mythos-class** and makes no such claim.

## Alternatives considered

- **Trust LLM findings without execution.** Rejected — hallucinated findings are the failure mode of naive "ask an LLM for bugs"; execution verification is the whole point.
- **Frontier model everywhere.** Rejected — the bake-off shows it is 18–47× more expensive per verified finding with no recall advantage on this work; reserve it for hard cases via the router.
- **Fix on GLM as the frontier brand.** Rejected — the lane is empirically selected; `qwen3-235b-a22b-2507` currently wins.

## Test contract

- Deterministic unit tests (no LLM) for the harness core, router, learning loop, and OpenRouter client (mocked `fetch`) — part of the standard suite (`@metaharness/projects`, 117+ tests).
- Real-LLM benches are `skipIf`-gated on `OPENROUTER_API_KEY`, bounded by request caps, and each writes a committed receipt; they are excluded from the deterministic `run-all`.
- Before any production model-selection claim: re-run the bake-off and discrimination scan multi-seed and gate with the ADR-162 four-split bootstrap.

## References

- Claude Mythos coverage (defensive-readiness framing): Bain, Contrast Security, AISLE, Cycode, ArmorCode (2026).
- OpenRouter (model access + pricing); the open/Chinese frontier models benchmarked (Qwen3, DeepSeek, Kimi, MiniMax, GLM).
- Receipts: `packages/projects/bench/results/{zero-day-discovery,real-corpus-scan,proposer-bakeoff,chinese-frontier-bakeoff,learning-loop,escalation-llm,handoff-llm}.json`.
- Internal: ADR-155 (Darwin Shield invariants), ADR-156 (program thesis), ADR-157/158/160/161/163 (modules this harness composes).
