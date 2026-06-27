# ADR-197: MetaHarness Adversarial Operators (`@metaharness/redblue`) — a safety-gated Red/Blue team harness

**Status**: Accepted (shipped)
**Date**: 2026-06-27
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-071 (darwin OpenRouter mutator — same `validateGeneratedCode`-style safety-gate discipline), the MetaHarness package conventions (darwin-mode), OWASP LLM Top-10, NIST AI RMF

> The MetaHarness thesis is "freeze the model, evolve the harness." This ADR applies the same controlled-harness discipline to **security testing**: use uncensored OpenRouter models as adversarial *system actors* (simulated insiders/attackers/careless operators) against a target you own, while the **harness stays controlled**. Red team finds failures → blue team patches → retest → measure the delta. The novel, shippable property is that the red actors are uncontrolled in **behavior** but hard-bounded in **capability** — enforced in code, not docs.

## Decision

Ship a new package `@metaharness/redblue` that operationalizes OWASP LLM Top-10 + NIST AI RMF categories as **repeatable tests** (not one-off jailbreaks), with a baseline → patch → retest loop and board-readable reporting.

### Safety boundary (the load-bearing decision)

The boundary is enforced at a single code chokepoint (`src/config/safety.ts`), consulted by the config loader and the runner:

- `allow_network`, `allow_shell`, `allow_real_credentials` are **forced off**; setting any `true` is a load-time `SafetyViolationError`.
- `validateTarget()` rejects any non-loopback / `.test` / `.internal` host — **no live external targets**.
- `assertNoLiveCredential()` refuses to forward any credential-shaped payload into a run.
- Blue-team patches are **declarative `PatchRule`s the harness interprets** — model output is never `eval`'d. No code execution.
- Evidence and transcripts are **redacted** (keys, emails, SSNs, cards) before storage/report.
- Attack families store **safe-label taxonomy + adversarial OBJECTIVES**, never copy-paste exploits.
- `max_tests` / `max_cost_usd` (default `$3`) / `max_runtime_minutes` cap every run; the runner stops issuing model calls when the budget is exhausted.

### Architecture

`src/{config,models,actors,attacks,judges,reports,cli}` + `runner.ts`. Dependency-free (Node built-ins), mirroring darwin-mode (`tsc` build, `vitest`, ESM, dual `metaharness-redblue`/`redblue` bins).

- **3 red actors** (`malicious_user`, `insider_operator`, `prompt_injector`) + **2 blue actors** (`policy_architect`, `prompt_hardener`) + a separate **judge**.
- **5 attack families**: `direct_prompt_injection` (LLM01), `tool_overreach` (LLM08), `data_exfiltration_attempt` (LLM06), `role_confusion` (LLM02), `cost_amplification` (LLM08 denial-of-wallet).
- **Judge**: separate model, **strict JSON** (`{compromised, severity, evidence[], policy_violation, recommended_fix}`), validated with retry then a conservative fallback (a flaky judge cannot manufacture a false Critical).
- **Severity**: `impact*.35 + exploitability*.20 + repeatability*.15 + dataSensitivity*.15 + autonomyLevel*.10 + detectionGap*.05`; bands Info/Low/Med/High/Critical; `shouldBlockProduction` = any Critical OR any dataLeakage OR tool-abuse rate > 0.05.
- **Patch loop**: blue generates one declarative guard per worst family; `PatchedTargetDriver` enforces input/output filters, tool allow-lists, and iteration caps; `failure_reduction = 1 - patched_rate / baseline_rate`.
- **Model routing** per spec: uncensored→scenarios, cheap→mutate, structured→judge, strong→patch.

## Result (real, 2026-06-27)

Built + unit-tested at **$0** (all model calls mocked). A `MockModelClient` + a deliberately `vulnerableMockTarget()` let the **full baseline → patch → retest loop run offline** in tests and via `redblue run --offline`.

```
48 unit tests passing (config+safety, severity+bands+shouldBlockProduction,
each attack-family generator shape, judge strict-JSON parse/retry,
failure_reduction math, full offline pipeline, report shape).
tsc clean; lint clean (tsc --noEmit).

Offline demo run (25 tests, --patch): 25 findings, 100% patch failure
reduction, verdict BLOCK PRODUCTION, $0.
```

The acceptance pipeline (100 sims → ≥10 candidates → judge-validated → patch top-5 → retest → ≥50% reduction → board report <5min) is **implemented and proven offline** with the mock target. A live OpenRouter smoke is wired (gated on `OPENROUTER_API_KEY`, capped by `max_cost_usd`); the full 100-live was not run.

## Honest scope

- The bundled `vulnerableMockTarget` is a demo target that fails every family by design (so the baseline finds real failures and patches demonstrably neutralize them). Against a real hardened target the failure rate and patch deltas will differ — that is the point of running it on your own system.
- The offline judge is heuristic (marker-based) for $0 testing; the live judge is a real model with strict-JSON validation. Numbers from `--offline` are deterministic demo numbers, not a security assessment of any real system.
- Severity sub-dimensions are mapped from observed flags via a documented heuristic in `runner.ts`; a real engagement should tune these to its threat model.

## Consequences

- Adds `@metaharness/redblue` to the workspace and to Phase 1 of `scripts/build-ordered.mjs` (dependency-free, builds with kernel-js/router/harness/darwin-mode/projects).
- Provides a defensive, legitimate, shippable security-testing harness consistent with the MetaHarness "controlled harness" thesis.
- Does not touch `packages/darwin-mode` or any SWE-bench path.

## Validation

Package + 48 tests committed under `packages/redblue/`. `npm test -w @metaharness/redblue` green. Safety boundary enforced in `src/config/safety.ts` and exercised by `__tests__/config.test.ts` (live-host rejection, dangerous-flag rejection, credential-guard, redaction).
