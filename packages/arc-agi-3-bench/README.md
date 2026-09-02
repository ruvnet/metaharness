# ARC-AGI-3 AVO paired benchmark

Private benchmark tooling for controlled `ArcAvoLoop` ablations. Every arm uses
the same provider-neutral `ArcController`, exact observation pipeline, action
budget, receipt chain, and `ArcAvoLoop`. Only the cognitive feature profile and
model-visible context change.

This package does **not** contain the OpenAI SDK and does not read an OpenAI API
key. Its built-in run is a deterministic mechanism test, not an official ARC
score or a general intelligence claim.

## Arms

| Arm | Shared loop configuration | Model calls per decision |
| --- | --- | --- |
| `direct` | `DIRECT_ACTOR`; one candidate; no memory/frontier | one plan call |
| `direct-reflection` | `DIRECT_ACTOR`; one candidate; non-binding reflection | one reflection + one plan call |
| `avo` | `AVO_FULL`; bounded candidates, lineage, memory, frontier, guarded execution, blocking supervisor | one deliberation + one plan call; a supervisor call replaces deliberation when a case is open |

The reflection and AVO arms therefore have the same frozen model, sampling
declaration, maximum turn budget, and two model-call slots per decision. The
report also records input, output, reasoning, and total usage units. An arm that
reaches a terminal state consumes fewer calls; that efficiency is part of the
result rather than padded compute.

## Deterministic mechanism run

From the repository root:

```bash
npm run build --workspace @metaharness/arc-agi-3
npm run build --workspace @metaharness/arc-agi-3-bench
npm test --workspace @metaharness/arc-agi-3-bench
npm run benchmark --workspace @metaharness/arc-agi-3-bench > /tmp/arc-avo-report.json
```

Or invoke the JSON CLI directly after building:

```bash
node packages/arc-agi-3-bench/dist/cli.js manifest --compact
node packages/arc-agi-3-bench/dist/cli.js run \
  --driver scripted \
  --out /tmp/arc-avo-report.json \
  --compact
```

The manifest freezes the fixture hash, three arms, game-independent episode
seeds, randomized arm-order seed, controller thresholds, model declaration,
prompt/tool hashes, action/turn/wall budgets, statistical procedure, and
acceptance gate. The runner then:

1. Runs all arms on each identical task/seed pair in a deterministic randomized order.
2. Checks the initial scope-neutral observation fingerprint matches within each pair.
3. Verifies each core checkpoint and transition-receipt chain.
4. Reports score, actions, model turns, usage units, simulated latency, and observed wall time.
5. Resamples fixture-task clusters for the confidence interval and performs a cluster-level sign-flip permutation test.

Acceptance also fails closed unless every model turn reports complete input,
output, and reasoning usage; no dispatched model call failed; and the
direct-reflection/AVO compute protocol matches. Declared AVO usage per model
turn may not exceed the paired reflection control by more than 25 percent. For
each executed decision both
arms must have one plan call plus one deliberation slot. In AVO, a typed
supervisor call replaces that decision's ordinary deliberation call. Terminal
early stopping is allowed, so a successful arm is not padded with unnecessary
calls merely to equalize total consumption.

`deterministicEvidenceHash` excludes only `generatedAt` and observed wall-clock
diagnostics. It should match across repeated scripted runs. `reportHash` covers
the complete report, including those diagnostics.

The checked-in mechanism run is
[`results/mechanism-v1.json`](results/mechanism-v1.json). Across 18 paired
replicates in six fixture-task clusters, AVO won 18 of 18 episodes with a mean
2.333 actions; both direct controls won 0 of 18 with a mean 8 actions. Against
the compute-matched reflection control, the paired score delta was +100 with a
fixture-task-clustered 95 percent interval of [100, 100] and an exact one-sided
cluster sign-flip p-value of 0.015625. All ten acceptance checks passed. Its
deterministic evidence hash is
`854514a34bd1ed9679d8ef37b5c16005daa0c19738a96ef35a30589099db91e4`.

These values prove the intended causal mechanism on the frozen synthetic
fixture. They do not turn the fixture score into an official ARC score or a
general-intelligence measurement.

## Long-horizon durability run

From the repository root, the infrastructure probe can be reproduced with:

```bash
npm run benchmark:arc-avo-long-horizon -- \
  --out packages/arc-agi-3-bench/results/long-horizon-v1.json \
  --compact
```

The checked result is
[`results/long-horizon-v1.json`](results/long-horizon-v1.json). It completed,
checkpointed, content-addressed, reloaded, and integrity-validated 6,624
`AVO_FULL` actions. The run restored all 6,624 receipts, candidates, selections,
and outcomes with an exact checkpoint-hash match. Its logical checkpoint was
42,376,880 bytes, its durable descriptor was 17,994,644 bytes, and the store
wrote 26,497 content-addressed objects. On the recorded Linux/Node 24 run, the
action loop took 40.17 seconds, checkpoint construction 2.89 seconds, save 6.50
seconds, and reload 5.44 seconds. The report retains both identical checkpoint
hashes, a deterministic evidence hash, and a full report hash. A second fresh
run reproduced deterministic evidence hash
`332d1cfd8633ae69e0b5c32663ee4c4eef4cef3f162f4c80761f017108765d09`;
identity-bound checkpoint hashes and timings are deliberately outside that
deterministic hash scope.

The checked current-tree phase timings validate completion and scaling for one
local run. They are not a causal before/after performance estimate. The report
is also explicitly ineligible for ARC or intelligence claims because its stable
no-effect fixture tests infrastructure scaling only.

## Paired live smoke: failed gate

[`results/live-smoke-v2-paired.json`](results/live-smoke-v2-paired.json) retains
a redacted compact record of one seed-zero public online pair. `DIRECT_ACTOR`
and `AVO_FULL` both completed one of seven levels, scored 3.5714285714, and used
all 80 actions with valid receipt chains. AVO therefore showed no score gain.
The run used non-competition mode, one game, no replication, and no verified
model-usage matching, so it failed the live claim gate and cannot support an
ARC-performance or intelligence claim.

### Actor-declared-clean rerun: exploratory gain, gate still closed

[`results/live-smoke-v3b-clean-paired.json`](results/live-smoke-v3b-clean-paired.json)
records a later run whose separate actors declared no web, source,
other-run, prior-trajectory, or subagent access. AVO scored 3.267620848 versus
0.396825397 for direct and reached the first level in 23 rather than 66 actions,
a 43-action (65.15 percent) reduction. Both arms nevertheless completed only
one of seven levels, exhausted all 80 actions, and had valid receipt chains.

The +2.870795451 score difference is a real observation from this pair, but it
is below the frozen +10 gate and has no multi-game confidence interval. Exact
model usage was unavailable and competition mode was off. The artifact
therefore records `observedExploratoryImprovement: true`, `claimEligible: false`,
and `acceptance.passed: false`; it cannot establish a general ARC or intrinsic
intelligence improvement.

## Manual ChatGPT or external model broker

The file broker exposes the generic `ModelDriver` contract without automating a
ChatGPT UI or requiring provider credentials:

```bash
node packages/arc-agi-3-bench/dist/cli.js run \
  --driver file \
  --broker-dir /tmp/arc-chatgpt-broker \
  --visible-model "ChatGPT model label shown in UI" \
  --model-id "operator-declared model id" \
  --out /tmp/arc-chatgpt-report.json
```

For every turn the command atomically writes:

```text
/tmp/arc-chatgpt-broker/requests/<requestId>.json
```

Paste that request into a separate model conversation or feed it to any local
broker. Save an exact response at:

```text
/tmp/arc-chatgpt-broker/responses/<requestId>.json
```

The response must match the request kind exactly. Minimal examples are:

```json
{
  "schema": "metaharness.arc_agi_3.model_turn_response.v1",
  "requestId": "copy from request",
  "candidateActions": [
    {
      "action": { "name": "ACTION1" },
      "hypothesis": "concise public hypothesis",
      "confidence": 0.5
    }
  ],
  "usage": { "inputUnits": 0, "outputUnits": 0, "reasoningUnits": 0 }
}
```

```json
{
  "schema": "metaharness.arc_agi_3.model_turn_response.v1",
  "requestId": "copy from request",
  "reflection": "concise non-private advice",
  "usage": { "inputUnits": 0, "outputUnits": 0, "reasoningUnits": 0 }
}
```

For `SUPERVISE`, copy `caseId`, `caseHash`, and the current observation hash
from the request's typed `supervisorCase` and return a valid
`supervisorDirective`. Completed request/response pairs move to `archive/`.
Invalid and failed responses still consume a frozen model-turn slot.

The broker validates exact plain-data schemas, rejects extra or kind-incompatible
fields, accessors, non-finite values, and malformed usage. Broker responses are
read into a fixed 256 KiB maximum buffer, with an
extra-byte growth check; oversized or changing files are rejected. Model-visible
requests contain only an opaque task handle; fixture IDs,
hidden goal fields, raw game IDs, and provider credentials are not included.
Model identity, sampling settings, latency, and usage remain operator-declared;
this runner does not accept or authenticate an auxiliary provider receipt.

## Live ARC path and evidence boundary

The same `BenchmarkPlanner`, `BenchmarkSupervisor`, and `ModelDriver` are
environment-neutral and can be paired with `PythonArcBridge.startGame()` from
`@metaharness/arc-agi-3`. A valid live experiment must additionally:

- create a separate official scorecard for every arm/seed replicate;
- pass proxy and CA variables explicitly through the bridge environment when required;
- preserve the same game, seed, action/turn budgets, prompts, and randomized order;
- record the returned official scorecard instead of `mechanismScore`;
- never merge repeated runs into one scorecard before extracting per-run scores;
- label ChatGPT UI model identity and sampling settings as operator-declared.

The CLI intentionally refuses to relabel the built-in fixture score as live or
official. An official 25-game claim also requires the full public-game protocol,
competition settings, repeated seeds, and scorecard/receipt reconciliation—not
just this small causal mechanism fixture.
