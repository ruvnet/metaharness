# Live OpenRouter verification on ruOS

Date: 2026-10-26

Decision: retain opt in status. Live connectivity, replay qualification, protected confirmation,
rejection and signed bundle replay work. Useful performance improvement was not demonstrated.

The user authorized use of the existing OpenRouter key through ruOS secrets. Both runs used the
primary Work Desktop and its documented tmpfs runtime mount. Only the OpenRouter slot was read into
the trusted host process. Generated artifacts received no credentials, imports, file APIs or network
APIs. No key was printed, exported to this repository or copied to a different desktop. The existing
tenant LLM route was unchanged. The archive passed an exact key content check on the host before export.

Model: `qwen/qwen3.8-27b`, checked against OpenRouter's live models API before execution. Temperature
zero, explicit reasoning disabled, 1600 maximum output tokens per call, 36 maximum calls and eight
minute deadline per run. Combined maximum reservations remained under the authorized local $2 envelope.

| Measure | Result |
| --- | --- |
| Completed live API calls | 44 |
| Provider reported API charges | $0.01679392539 |
| List price token estimate | $0.0211651 |
| Conservative combined reservations | $0.2260198 |
| API latency median | 1.146 seconds |
| API latency p95 | 2.889 seconds |
| Task family attempts | 6 across two runs |
| Family attempts reaching confirmation | 4 |
| Accepted rewrites | 4, each with two fresh development replays |
| Baseline strict confirmation successes | 4 of 4 |
| Candidate strict confirmation successes | 3 of 4 |
| Independent retry successes | 8 of 8 |
| Promotions | 0 |
| Produced signed bundles independently replaying | 4 of 4 |

API charges exclude desktop infrastructure. Estimates and provider reported charges differ because
the estimate uses public input and output list prices without exact provider caching adjustments.
Retry controls use the same per call token ceiling, not equal total pipeline expenditure. Two runs
of three synthetic families are a smoke test, not a powered capability comparison. The second run
reused confirmation tasks and must not be presented as an independent holdout experiment.

## Findings

1. Deduplication: development replay and changed record based confirmation passed in both runs.
2. Intervals: run 1's runbook contained an incorrect adaptation rule for half open intervals. It
   passed both original development replays, but the assisted candidate passed only two of three
   confirmation checks while baseline passed all three. Promotion was correctly rejected. Run 2
   passed both baseline and candidate confirmation, still with no strict improvement or promotion.
3. Durations: discovery failed two of three checks in both runs, so no rewriting was admitted.
   The retained run 2 artifact assumes a single minute digit despite the public contract allowing
   multiple minute digits. Rejecting that discovery is correct; it is not a successful task outcome.

The failure demonstrates why development replay alone cannot authorize transfer. It does not prove
that rewriting is beneficial or harmful in general. Keep separate confirmation and anchor gates.
For optimization, evaluate task applicability and require runbooks to derive boundary conditions from
the current task. Any changed rewrite or reviewer policy needs a fresh confirmation set; do not tune
against these results and then count the same tasks as held out.

## Evidence and reproduction

[Evidence archive](./terminal-rsi-live-smoke.zip), SHA256:
`e142addf213eea8f428a3c2e71af809d86c552f668d730c48ccf510ab0d99f07`.

The archive contains both reports, every model call's usage and timing ledger, checkpoints, signed
promotion or rejection bundles and the 19 generated source artifacts retained in run 2. Run 1 did not
retain generated source and that gap is preserved in the report. Its original `allBundlesReplay:false`
summary mixed a missing bundle from a failed discovery into replay status. Both bundles that were
actually produced verify. The driver now reports bundle count and family coverage separately.

Run 1 source: `ecd209ade5e4df43a217b92a821a3dbe109f7c9e`.

Run 2 source: `b08c42f99495c072e2ea61d9855093647e58518a`.

The repeat added artifact retention and candidate anchor diagnostics for rejected proposals. The
diagnostic anchor evaluations did not change or enter the signed promotion decisions. Actor,
rewriter, reviewer and task prompts were unchanged. Both independent review calls used the same
model in separate contexts, so shared model errors remain a limitation.

```sh
npm run build --workspace @metaharness/flywheel
node packages/flywheel/scripts/verify-live-rewrite-evidence.mjs docs/validation/terminal-rsi-live-smoke.zip
node packages/flywheel/scripts/live-openrouter-rewrite.mjs --self-test
```

On an authorized ruOS host with the existing runtime secret mount, a new live smoke run can use:

```sh
REWRITE_CAP_USD=1 node packages/flywheel/scripts/live-openrouter-rewrite.mjs /absolute/new/evidence-directory
```

The output directory must be unique per run; the driver acquires an exclusive run claim before reading
credentials or writing evidence. Do not source the whole runtime environment into the
artifact evaluator. The restricted Python worker is a limited pure function language with resource
limits, not a general terminal sandbox. Verification keeps expected results outside generated code.
The offline verifier checks receipt consistency and artifact hashes, not remote host attestation.

Validation: the ruOS build and all 198 Flywheel tests passed. Driver self tests check valid execution,
import rejection, private attribute rejection and mutation rejection. Scoped Ruflo 3.25.6 deep source
scans of both new execution scripts returned zero findings; no advisory feed timestamp was exposed.
This is not a dependency or production security certification.
