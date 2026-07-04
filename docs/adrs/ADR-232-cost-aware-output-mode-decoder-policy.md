# ADR-232: Cost-aware output-mode decoder policy for the Fable escalation stack

- **Status**: Proposed — reference implementation landed; live acceptance run budget-gated (unrun)
- **Date**: 2026-07-04
- **Deciders**: ruv
- **Tags**: metaharness, swebench, cost, fable, cascade, output-modes, decoder-policy, governance, observability, cost-per-accepted
- **Extends**: [[ADR-205]] (harness handoff — darwin as router, `claude -p` + Fable as hard-tail actuator), [[ADR-231]] (provably-clean SOTA — verifier-vs-lagged-truth discipline, receipt streams)
- **Generalizes (meta-llm)**: **ADR-237/238** typed-action control plane — the `diagnosis` + `recommendations[]` "decisions, not prose" pattern is this ADR's lever 3 (the invariant-gated verdict) already shipped on the server side
- **Reference implementation**: `packages/darwin-mode/bench/swebench/output-modes.mjs` (+ `output-modes.test.mjs`, 22 passing pure-logic tests), `output-modes-replay.mjs` ($0 modeled-replay on committed artifacts), wired into `solve-agentic.mjs` + `handoff-solver.mjs` behind the additive `--output-modes` flag.

---

## 1. Context

The FABLE-REPORT (`docs/FABLE-REPORT.md`) establishes Fable 5 as the best hard-tail code-repair actuator we measured (92% on hard-25) and the **most expensive per token** ($10/M input, **$50/M output** — output is 5× input). ADR-205 makes Fable the top rung of the escalation cascade: darwin routes, and the hard tail is handed to a `claude -p` + Fable subprocess.

The naive cost lever is to shrink *input* (prompt caching, retrieval). But **output tokens cannot be hidden**: the model must generate them, they are billed at the 5× rate, and — critically — in the `claude -p` loop the patch is captured from `git diff`, so any prose the model writes *around* the patch is **billed and then discarded**. The lever with the most headroom on the Fable rung is therefore to make Fable **write less / later / not at all**, and to optimize **cost-per-ACCEPTED-task**, never input alone.

Where Fable currently over-generates: the ADR-205 handoff prompt asks for a minimal change but does not forbid a final explanatory essay; the `claude -p` loop narrates its reasoning every turn; and there is no structured verdict/continuation contract, so review and "keep going?" decisions are prose.

## 2. Decision

Adopt a **cost-aware output-mode decoder policy**. Every generation on the cascade is assigned an output *mode* with a token budget wired to the gateway `max_tokens`; the Fable rung is constrained to a narrow, prose-free mode set; and the objective is cost-per-accepted-task under hard correctness/defect/receipt gates.

### 2.1 Two mode enums (load-bearing)

The general decoder policy (§10):

```ts
type OutputMode = "verdict_only" | "patch_only" | "capsule" | "json_delta" | "full_prose";
outputBudgets = { verdict_only:200, patch_only:1200, capsule:800, json_delta:600, full_prose:2500 };
chooseOutputMode(task): needsCodeChange→patch_only; isReview→verdict_only;
                        isAgentHandoff→capsule; isReport→json_delta; else full_prose
```

The **loop-scoped** enum, which structurally excludes prose:

```ts
export type FableOutputMode    = "verdict_only" | "minimal_patch" | "need_context" | "blocked";
export type TerminalOutputMode = "renderer_prose" | "cheap_model_prose" | "template_fill";
```

`full_prose` is a **terminal renderer mode only** — and preferably NOT Fable (a cheap model or a template renderer writes final prose). Fable inside an agent turn must never be asked for prose. This is enforced structurally, not by prompt:

```ts
const FABLE_FULL_PROSE_ALLOWED = false;              // governance switch, §2.7
function assertFableLoopMode(mode: string) {
  if (!["verdict_only","minimal_patch","need_context","blocked"].includes(mode))
    throw new Error(`Fable full_prose is forbidden inside the loop: ${mode}`);
}
```

### 2.2 Effective-cost scorer

```
effective_cost = input_tokens*input_price + output_tokens*output_price + retries*expected_retry_cost
```

Per-provider prices (`PRICES`, from `agent-registry.mjs` + FABLE-REPORT §4; Fable = $10/$50 per M). The optimizer targets **cost-per-accepted-task**, never input alone.

### 2.3 Output-contract enforcement + the non-Fable retry chain

Each mode maps to a `max_output_tokens` cap (the budget IS the wire cap) + an allowed/forbidden-sections schema. `validateOutput` REJECTS a violating output and returns the next ladder action. **Fable is never re-invoked to fix formatting** ("a formatting failure is not an intelligence problem"):

```ts
async function handleContractViolation(result, raw) {
  if (result.ok) return result.parsed;
  const local = tryLocalRepair(raw);              if (local.ok) return local.parsed;      // 1. free
  const normalized = await cheapNormalize(raw);   if (normalized.ok) return normalized.parsed; // 2. cheap model
  const smaller = await retryWithSmallerContract(raw); if (smaller.ok) return smaller.parsed; // 3. shrink schema
  throw new Error("Contract failed after non-Fable repairs");                                  // 4. never Fable
}
```

Fable is re-invoked ONLY when the **semantic** task failed (verdict = revise/escalate) — a different code path.

### 2.4 Draft-cheap / verify-expensive (strongest lever) + latent-defect invariant

A cheap model (glm/deepseek) drafts; Fable emits a small **verdict JSON** with an invariant checklist baked in — decisions, not vibes:

```
{"verdict":"accept|revise|escalate",
 "invariants":{tests_pass, no_public_api_change, no_security_regression, minimal_diff, acceptance_criterion},
 "blocking_issues":[], "minimal_patch":"<only if verdict!=accept>"}
```

`parseVerdict` enforces the **latent-defect invariant**: an `accept` whose invariants are not all-true (or are unanswered) is **downgraded to `revise`**. This is the fix for budget-induced under-specification — a terse verdict is still forced to answer each invariant, so a hidden failure cannot launder an `accept` past the schema. **Terseness is bounded by invariant-based prompts, not by longer outputs.** For coding: Fable emits `minimal_patch` only, never narration.

### 2.5 Continuation-verifier gate

Before each expensive Fable turn a cheap check (`decideContinuationHeuristic` at $0, or a cheap-model call) early-stops failed trajectories:

```
{"continue_fable":true|false,"next":"run_tests|cheap_repair|stop|need_context","reason":"<=20 words"}
```

### 2.6 Capsule protocol (inter-agent handoff, ≤800 tok)

`{goal, state(≤5 bullets), changed_files, open_risks, next_action, confidence}` — the default inter-agent output between darwin/harness agents. Fable never emits a full reasoning trace between agents.

### 2.7 Observability preserved (the flagged risk)

`minimal_patch` can under-communicate intent, making post-hoc review harder. The fix is **NOT** letting Fable write prose — it is logging the full artifacts (diffs, tool outputs, verifier scores, capsules, receipts) **outside the model path** via `makeArtifactLogger`, which returns a receipt `{id, kind, sha256, bytes, ts}`. The model path only ever sees the receipt id. **`receiptCoverage === 1` is what makes terse output auditable.**

### 2.8 Priority hierarchy (the objective function — ordering is load-bearing)

1. **Correctness** → 2. **No latent defects** → 3. **Receipt completeness** → 4. **Cost per accepted task** → 5. Latency → 6. Token reduction.

**≥60% fewer Fable output tokens is NOT the objective — it is a constraint that only matters AFTER correctness and the defect/receipt invariants pass.** The optimizer targets #4 subject to #1–#3 as **hard gates**:

```ts
type EvalMetrics = { resolved, totalCostUsd, fableOutputTokens, retries, contractViolations, latentDefect, receiptCoverage };
function accepted(m) { return m.resolved && !m.latentDefect && m.receiptCoverage === 1; }
// costPerAcceptedTask = sum(totalCostUsd over ALL runs) / count(runs where accepted(m))
```

This is the **anti-pathological-win** definition: a run that "saves 70%" by accepting a thinner output that later fails does NOT count as accepted, so it cannot lower cost-per-accepted-task.

### 2.9 Governance + audit (durable, erosion-detectable)

**Lagged-truth split** (same verifier-vs-realized-outcome discipline as ADR-231 / ADR-0026):

```ts
type AcceptanceClass = "harness_accepted" | "user_accepted" | "latent_defect_found" | "rolled_back";
costPerHarnessAccepted = totalCostUsd / count(harness_accepted && !latentDefect && receiptCoverage===1); // PRIMARY optimizer target
costPerUserAccepted    = totalCostUsd / count(user_accepted && !rolled_back);                            // SHADOW calibration (delayed, noisy, economically real)
```

The harness metric drives optimization now; the user (shadow) metric is the calibration check that keeps the harness metric honest over time — it catches the Goodhart trap where output passes internal tests but is too terse to be operationally usable.

**Immutable audit line per Fable call** (append-only) makes erosion *detectable*, not merely forbidden:

```jsonc
{ "model":"fable", "mode":"verdict_only", "full_prose_allowed":false,
  "input_tokens":18422, "output_tokens":219, "contract_ok":true, "receipt_id":"..." }
```

**Erosion query** (ship in CI/audit — non-empty result = runtime contract violated):

```sql
select * from model_calls where model='fable'
  and mode not in ('verdict_only','minimal_patch','need_context','blocked');
```

Implemented as `detectErosion(auditRows)` (JSONL-scan equivalent); surfaced in the run report as `outputModes.erosionOffenders` (MUST be 0). `FABLE_FULL_PROSE_ALLOWED` is a governance constant, **not prompt-configurable** — only flippable by a signed runtime policy or an ADR-version bump, never by a task field. This is the security property that stops an agent smuggling prose back in with "explain your reasoning."

### 2.10 Recommended stage table

| Stage | Model | Mode | Note |
|---|---|---|---|
| Localize | GLM/DeepSeek | json_delta | file-list only — never prose |
| Draft | cheap | patch_only | cheap unified-diff draft |
| Test | tools | (no model output) | run the repo tests |
| Review | **Fable** | **verdict_only** | verdict JSON <300 tok, invariant-gated |
| Repair | **Fable** | **minimal_patch** | minimal diff ONLY on failure |
| Final | cheap/renderer | full_prose | template-fill — **NOT Fable** |

Input policy (cache-first → retrieve-second → pxpipe only for static read-mostly context) is a **separate experiment** — input and output savings must not be blended into one number, or the input floor produces a false blended win.

## 3. Consequences

**What changes.** Under `--output-modes`, the Fable/`claude -p` rung runs in `minimal_patch` (asserted — never `full_prose`); the handoff prompt appends an output contract forbidding a final prose narration; each Fable call emits an audit line; the report carries an `outputModes` summary with the erosion count. Default runs (flag absent) are **byte-identical** to pre-ADR-232 behaviour.

**What the $0 modeled-replay shows (on committed artifacts — `predictions-e4/e5/e6-tail.jsonl`, 376 real hard-tail patches).** ALL savings numbers are **MODELED** (merge criterion #4):

- **MEASURED (no modeling):** 363/376 (96.5%) of real final patches fit the `minimal_patch` (1200-tok) budget; 94.7% fit `capsule` (800). The budgets are calibrated to real outputs.
- **MODELED:** at 300 narration tok/turn (typical `claude -p` reasoning is 200–800), the policy models **72.5% lower Fable output tokens**; ≥60% is reached once narration ≥ ~300 tok/turn. **Total** cost saved is only **~12%** because the ~62k-token `claude -p` system-prompt **input floor dominates** — output policy alone does **not** clear the ≥50% total-cost gate at that floor; that requires the separate input-policy experiment. This is the honest thesis nuance: output can't be hidden, but the input floor caps *total* savings.
- Pre-greenlight #1 (10 hardest real fixes deliverable under terse `minimal_patch`): 10/10 on the **necessary** condition (fix content is expressible; narration is not fix content). The **sufficient** test — whether terse output degrades Fable's problem-solving — needs the live run.

**What hurts / residual failure modes.** (a) `minimal_patch` under-communicates intent — mitigated by receipt coverage, not prose. (b) `claude -p` has no per-turn `max_output_tokens` flag, so on that rung the prompt contract + git-diff capture are the enforcement; a hard per-turn cap needs the direct-API rungs (future work). (c) The modeled 60%/50% is **not** a live result and must never be reported as one.

## 4. Alternatives considered

- **Shrink input only** (caching/retrieval). Rejected as the primary lever: output is the 5× cost and the un-hideable one; input is a separate experiment.
- **Let Fable narrate, strip prose post-hoc.** Rejected: the prose is already billed. The saving must happen at generation.
- **One general `OutputMode` enum.** Rejected: a single "explain your fix" prompt silently destroys the economics. The `FableOutputMode` split + `assertFableLoopMode` + `FABLE_FULL_PROSE_ALLOWED` make prose structurally impossible in-loop.
- **`accepted = resolved`.** Rejected: invites the pathological cheap win. `accepted` gates on resolved AND no latent defect AND full receipts.

## 5. Test Contract

- **Pure logic** (`output-modes.test.mjs`, 22 tests, all passing): mode selection (both enums), the `assertFableLoopMode` guard (throws on prose), budget→max_tokens, effective-cost + `accepted`/`costPerAcceptedTask` anti-pathological-win, the non-Fable retry chain, `parseVerdict` invariant-downgrade, the continuation schema, capsule validation, the artifact logger + receipt coverage, the governance harness/user split, the audit line + `detectErosion` erosion query, and the merge criterion.
- **$0 modeled-replay** (`output-modes-replay.mjs`): runs on committed artifacts; emits the modeled-replay table (`full_prose` baseline row) + narration sweep + the pre-greenlight recovery result; every savings number labeled MODELED.
- **Wiring**: `solve-agentic.mjs --output-modes` forces the Fable rung to `minimal_patch`, writes `fable-audit.jsonl`, and reports `erosionOffenders` (asserted 0). Default run byte-identical (verified: `buildHandoffPrompt` with no `outputMode` is unchanged).

### 5.1 Final merge criterion (this PR must satisfy — machine-checkable as `MERGE_CRITERION`)

- **No Fable prose in-loop.** (`assertFableLoopMode` throws; `FABLE_FULL_PROSE_ALLOWED=false`; `detectErosion` = 0.)
- **No accepted run without receipt.** (`accepted()` requires `receiptCoverage===1`.)
- **No cost win counted without acceptance.** (`costPerAcceptedTask` divides by `accepted` only.)
- **No modeled claim reported as live result.** (Every replay number labeled MODELED; live table empty until the gated run executes.)

### 5.2 Live acceptance gate (budget-gated — DO NOT RUN without user greenlight)

Replay 50 historical Fable runs and confirm the **7-metric gate**, plus the sharper pre-greenlight diagnostic:

| Metric | Threshold |
|---|---|
| Same resolved count | no regression |
| Fable output tokens | ≥60% lower |
| Total cost per accepted task | ≥50% lower |
| Retry increase | <5% |
| Contract violations after first retry | <10% |
| Accepted latent defects | zero known increase |
| Debug-artifact receipt coverage | 100% |

Pre-greenlight (feature this): pick **10 historical failures where Fable eventually SUCCEEDED after verbose turns**; the new policy must still recover **≥9/10** using ONLY `verdict_only`/`minimal_patch`. This tests that terse output does not lose Fable's recovery power — stricter than the 50-run count test.

Estimated spend: FABLE-REPORT §4 ≈ $2.50/inst on the hard tail → ~$63 for a 25-inst slice, run TWICE (policy ON vs OFF) ≈ ~$126. Command:

```
OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
  bench/swebench/solve-agentic.mjs --manifest scholar-hardtail.json \
  --model deepseek/deepseek-chat --escalate-to claude-p-fable --escalate-policy aggressive \
  --output-modes --max-cost 70 --concurrency 2 --out predictions-om-on.jsonl --report om-on-report.json
# baseline: identical WITHOUT --output-modes
```

## 6. References

- `docs/FABLE-REPORT.md` — Fable 5 performance/cost (the escalation economics this ADR optimizes).
- ADR-205 — harness handoff (the cascade this policy wires into).
- ADR-231 — provably-clean SOTA (the verifier-vs-lagged-truth discipline reused in §2.9).
- meta-llm ADR-237/238 — typed-action control plane ("decisions, not prose"), the server-side precedent for the invariant-gated verdict (lever 3).
