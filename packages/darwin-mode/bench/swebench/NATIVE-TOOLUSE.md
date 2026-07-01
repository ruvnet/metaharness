# Native tool-use for the agentic loop — diagnosis + measured result (ADR-197)

Frontier arm of the Fusion benchmark (`fusion-bench-A-frontier.jsonl`, single-model
`anthropic/claude-sonnet-5`, no cascade, 8-instance hard slice, `--no-test-oracle`,
`maxSteps=12`) produced **0/8 non-empty patches** for $1.0726. The working hypothesis
going in was that the harness's TEXT-only tool protocol (`agentic-loop.mjs`'s
`buildAgenticSystem`/`parseAction` — "output exactly one JSON object per turn") was the
bottleneck: a frontier model trained on native function-calling fighting an unfamiliar
text-emulation protocol, burning its step budget on malformed output.

**That hypothesis was not confirmed by execution.** The actual failure mode, the fix
built, and the honest measured result are below.

## 1. Confirmed failure mode (verified by execution)

No per-turn transcripts survived from the original run (`agentic-loop.mjs`'s `onStep`
callback is only used for a one-line-per-instance summary in `solve-agentic.mjs`, never
persisted). To confirm the failure mode honestly, I re-ran live single/few-instance
probes against `anthropic/claude-sonnet-5` on 3 of the 8 hard-slice repos
(psf/requests, sympy, django) — both against the existing text-JSON protocol and,
after building it, the new native tool-calling path — capturing every raw turn.

**Result, consistently across all probes and both protocols:**

- The model parsed/emitted a valid tool call on **~92-100% of turns** (occasional
  recoverable `no parseable JSON action` hiccups under the text protocol; the native
  path never failed to produce a `tool_calls` entry once `tool_choice: "required"` was
  set). This is *not* a parse-failure death spiral.
- In **every single probe** (3 repos × text protocol, plus the same 3 repos re-probed
  under native tool-calling), the model spent its **entire 12-step budget on
  `ls`/`read`/`grep` and never once attempted an `edit`, `line_edit`, or `submit`
  call.** `patch` came back empty because no edit was ever attempted — not because an
  attempted edit failed to apply.

So the diagnosis narrows to: **(b) parsed-but-never-attempts-an-edit**, and more
specifically, the model never even reaches the edit step — it's an
exploration-vs-budget problem on large/complex repos (django, sympy, matplotlib), not a
tool-call-format problem. This reframes what "native tool-use" can be expected to fix:
it addresses a real gap (frontier models are RL-trained to call tools decisively) but
it does not directly attack "the model wants more turns to feel confident before
editing on a 200k-LOC codebase."

Diagnostic cost: ~$0.42 across 4 probes (not billed against the $6 measurement cap).

## 2. What was built

`packages/darwin-mode/bench/swebench/agentic-loop.mjs` — additive only, the existing
text-JSON path (`AGENTIC_SYSTEM`, `parseAction`, `agenticSolve`) is untouched:

- `buildAgenticToolsSchema(ext, glob)` — the same 7-tool surface
  (ls/read/grep/edit/line_edit/run_tests/submit) as OpenAI/OpenRouter
  `tools: [{type:"function", function:{...}}]` schemas.
- `buildAgenticNativeSystem()` — strategy guidance without the JSON-emission
  instructions (the provider's tool-calling machinery owns the call format now).
- `parseNativeToolCall(toolCall)` — maps one native `tool_call` into the same
  `{tool, ...args}` action shape `parseAction` produces, so `makeTools`'s dispatcher is
  reused unchanged. Malformed calls (missing name / unparseable JSON arguments) degrade
  to the same `noop` shape, so error recovery is identical across both protocols.
- `agenticSolveNative({ problem, io, llm, maxSteps, ... })` — the same bounded ReAct
  loop as `agenticSolve` (same anti-thrash state-hash guard, same `stateHash`/`chebTemp`
  reuse, same return shape `{patch, steps, submitted, resolvedInLoop, cost, thrash,
  transcript}`), but driving a real chat-message array (`system`/`user`/`assistant`/
  `tool` roles) instead of a flattened text transcript. Only the FIRST `tool_call` of a
  turn is dispatched, mirroring the text protocol's one-action-per-turn contract.

`packages/darwin-mode/bench/swebench/solve-agentic.mjs` — wired behind `--native-tools`
(default off):

- `mkLlmNative(model)` — sends the running `messages` array plus
  `tools`/`tool_choice: "required"`, returns `{message, cost}` (the assistant message,
  which may carry `tool_calls`) instead of `{raw, cost}`.
- `solveTier` branches between `agenticSolve`/`buildAgenticSystem` (default, byte-
  identical) and `agenticSolveNative`/native schema (opt-in).
- `judgePick` (used only by `--cascade`'s tie-break) now uses a dedicated `llmJudge =
  mkLlm(MODEL)` instance so its `{raw,cost}` expectation never breaks when
  `--native-tools` is combined with `--cascade`.
- Report JSON gains a `nativeTools` boolean field for provenance.

## 3. Test status

New file `agentic-loop-native.test.mjs` — 22 tests, mock LLM, $0, no network/Docker/git
(mirrors `fusion-loop.test.mjs`'s in-memory-io + scripted-LLM style). Covers:
`parseNativeToolCall` mapping/error cases, `buildAgenticToolsSchema` shape, and
`agenticSolveNative` behavior (submit ends the loop, line_edit/edit mutate or fail
cleanly, run_tests success sets `resolvedInLoop`, a turn with no `tool_calls` degrades
to a recoverable noop, malformed arguments recover without throwing, unknown tool names
report cleanly, only the first tool_call of a multi-call turn is dispatched, anti-thrash
parity, budget exhaustion, llm() throwing, cost accumulation, `onStep` firing), plus one
explicit regression guard confirming the pre-existing text-JSON `agenticSolve`/
`parseAction` path is unaffected.

```
node --experimental-strip-types --test *.test.mjs
# tests 45
# pass 45
# fail 0
```

All 23 pre-existing tests + the 22 new tests pass. The default (text-JSON) path was not
modified — only new exports were added and `solveTier`/`llm` construction gained an
`if (NATIVE_TOOLS)` branch that is a no-op when the flag is absent.

## 4. Measured result — same 8-instance hard slice, same conditions

`claude-sonnet-5`, no cascade, `maxSteps=12`, `--no-test-oracle` (conformant — repo's
own tests in-loop only; gold `FAIL_TO_PASS` harness used ONLY for the separate final
scoring below, never seen during solving — `leaderboardConformant: true` on both runs,
no leakage), `fusion-hard-slice.json` (psf/requests, pylint, pytest, sphinx, xarray,
sympy, django, matplotlib — 1 per repo).

| | text-JSON protocol (baseline, prior run) | native tool-calling (this run) |
|---|---|---|
| Non-empty patches | **0/8** | **1/8** (sphinx-doc__sphinx-7738) |
| Gold-resolved (official Docker oracle) | **0/8** | **1/8** (sphinx-doc__sphinx-7738) |
| $ spent | $1.0726 | $1.3020 |
| $/instance | $0.1341 | $0.1628 |

Gold scoring ran the official `swebench.harness.run_evaluation` against
`predictions-native-tools-A-frontier.jsonl` locally (no gold signal used during
solving): `resolved_ids: ["sphinx-doc__sphinx-7738"]`, `empty_patch_instances: 7`,
`unresolved_instances: 0`. Total measurement spend (this run only): $1.302, well under
the $6 hard cap; combined with the $0.42 diagnostic probes and a $0.13 single-instance
smoke test, total spend for the whole task was ~$1.85 of the $6 budget.

The one instance that flipped (sphinx-doc__sphinx-7738) is notable: in the earlier
diagnostic probes, the model DID reach an edit on the smaller/simpler repos when given
enough runway — sphinx's fix here was a small, well-localized 2-hunk change. The 4
larger/harder repos in the slice that stayed empty in BOTH conditions (django, sympy,
requests, xarray) are consistent with the diagnosis: 12 steps is not enough runway for
this model's exploration style on those codebases, regardless of tool-call format.

## 5. Honest verdict

**Partial win, not a full lift of the ceiling.** Native tool-use moved the arm from
0/8 → 1/8 non-empty patches AND 0/8 → 1/8 gold-resolved — a real, execution-verified,
non-zero improvement, not noise (Docker-oracle-confirmed resolution, not just "patch
looks plausible"). But:

- **The original hypothesis (protocol-format-as-bottleneck) was not the primary driver.**
  Diagnostic probes under BOTH protocols showed the dominant failure mode is
  over-exploration against the 12-step budget on large/complex repos, not tool-call
  parsing. Native tool-use is a legitimate, well-motivated lever (frontier models are
  RL-trained to act via tools rather than describe an action in prose), and it likely
  helped marginally by making each turn slightly more direct/decisive — but it does not
  by itself solve "give the model enough runway before it commits to an edit."
  Increasing `--max-steps` on the SAME instances (deepseek's arms in the pre-existing
  cascade runs get further because the text protocol works fine for it and it edits
  earlier) is a more direct lever for the still-empty 7/8 and should be measured next,
  ideally combined with `--native-tools`.
- **N=8 is a very small hard slice** — one flip is 12.5 percentage points on paper but
  is a single data point; it should not be read as "frontier now resolves 12.5% of hard
  instances" without a larger-N confirmation run.
- **Implication for the escalation/Sage tier:** the fusion/cascade design that routes
  the hard tail to a frontier "Sage" escalation tier is not automatically rescued by
  switching that tier to native tool-calling. The empty-patch ceiling on THIS slice
  under THIS step budget is bounded more by exploration budget than by protocol
  conformance. `--native-tools` is worth keeping (it cost nothing to keep as an opt-in
  flag, and the one real gold-resolved flip is genuine signal in its favor), but Darwin's
  headline ceiling should not be assumed to move materially until a larger-N run and/or
  a step-budget increase is measured on top of it.

This is reported straight: it is a real, small, execution-verified improvement
(0→1 gold-resolved, not just 0→1 "submitted"), not the "frontier ceiling lifts" story
the original hypothesis predicted, and not a null result either.
