# Self improving systems: source audit and bounded live trial

Decision: keep MetaHarness strict verification and promotion gates. RRSI supplies useful experimental search components, but this assessment found no evidence that replacing the current approach improves performance. No production promotion, merge or deployment was performed.

## Runnable systems

| System | Pinned source | Executed validation | Integration finding |
| --- | --- | --- | --- |
| [RRSI](https://github.com/google-research/rrsi) | be50316e1db05914068a973f322770ef08ed7ba1 | 8 core tests passed; CLI and compilation passed | Native proposer, schedule, history and selection can be adapted. Search provider needs an OpenRouter bridge. Keep upstream analyst/digester off credential bearing hosts because its shell boundary is insufficient. Apache 2.0; third party terms separate. |
| [ModularRSI](https://github.com/IQuestLab/ModularRSI) | ed1e545bc60f050b404474e51ee18021777a0e23 | 468 targeted tests passed; six native smoke checks passed | Useful module isolation and tracing. Promotion uses crash sanity rather than fresh reward superiority. Research additions are CC BY NC 4.0, distinct from Harbor base license. No code vendored. |
| [MASS](https://github.com/SakanaAI/MASS) | fb403581bed2c974b3f99e7236224169da643079 | 12 tests passed with inference mocked | Research loop is runnable, but published performance was not reproduced. No public license assigned to MASS specific code. Full training recipe needs substantial GPU compute. No code copied. |
| AIDE and AIDE² | AIDE ad73d227af481bea3de06f884f41b2993dd6453a | Production function contract probe | Original AIDE is MIT but is not the AIDE² outer loop. OpenRouter backend rejects required function specifications. Public AIDE² outer loop source was not found. |

Total: 488 upstream tests passed. These verify software behavior, not recursive capability improvement or AGI. Detailed observations are in `rsi-system-audit.json`. AIDE² authors explicitly report no ignition and a statistically inconclusive efficiency comparison: https://www.weco.ai/blog/first-evidence-of-recursive-self-improvement .

## Native RRSI component pilot

The host adapter uses the actual pinned RRSI proposer, schedule, History, aggregate and select_round. It is not the full upstream Run and does not reproduce its published benchmark. The upstream shell analyst/digester and critic are omitted. Only reusable instructions can change. Four development tasks and four distinct confirmation tasks each have two trials. Gold answers remain on the host. Actors run in the restricted Python worker without credentials. The host reads only the existing OpenRouter slot through ruOS. Tenant model routes were not changed.

Models: qwen/qwen3.8-27b actor and moonshotai/kimi-k3.1-pro proposer. Fixed limits: 1800 output tokens per call, 72 calls and 600 seconds per pass, four seconds per worker invocation. Acceptance adds strict development lift, no per task mean regression, complete accounting and no increase in actor API cost per success. Proposer cost is reported but not amortized into that selection metric, limiting economic conclusions.

| Pass | Calls | Provider cost USD | Outcome |
| --- | ---: | ---: | --- |
| 1, six proposer turns | 36 | 0.04182227676 | Proposal budget exhausted before completion. No candidate evaluated or accepted. Baseline development 0.125; baseline and retained confirmation both 0.5. |
| 2, twelve proposer turns | 19 | 0.03255878934 | Candidate evaluation interrupted by malformed truncated JSON in response 019. No completed candidate evaluation, confirmation or promotion. |
| Total | 55 | 0.07438106610 | Zero accepted changes; one complete and one incomplete pass. |

The second pass is a protocol correction, not an independent replication. It reuses confirmation specifications, though it stopped before confirmation. The original output token ceiling remained fixed. No further paid retries were made. First pass invalid proposal rounds were not separately persisted; retained API responses preserve their actions. Incomplete pass costs remain in the archive and verifier totals.

Combined consumed reservation: $1.059315046 against the original $3 ceiling. Reservation is a conservative internal cap, not the provider charge. The earlier Terminal RSI smoke cost $0.01679392539 across 44 calls and also accepted zero changes. Combined provider charges across these experiments: $0.09117499149 across 99 calls.

## Evidence and acceptance test

Archive `native-rrsi-evidence.zip` SHA256: `11dfe1433e95fae0ea54ad8a4febe2641435ba12420555510d56dba8f3daa783`. Export scanned exact credential bytes before transfer. Archive contains both pass ledgers, frozen task sets, responses and generated artifacts. It contains no credential file. Offline verification reexecuted 32 recorded trials, checked 35 artifact digests, and counted all 55 calls including the incomplete pass. This is consistency checking, not cryptographic provider or host attestation.

```sh
python3 packages/flywheel/scripts/verify-native-rrsi-evidence.py \
  docs/validation/native-rrsi-evidence.zip \
  packages/flywheel/scripts/restricted-python-worker.py
```

Expected: verified true, passes 2, incompletePasses 1, calls 55, reexecutedTrials 32, acceptedDevelopmentChanges 0, apiCostUsd 0.0743810661.

Next integration priority is robust actor output handling with failed trials retaining charges, followed by an independently frozen, larger comparison against the unchanged harness under equal total budgets. Native RRSI components should stay experimental until that comparison shows fresh strict success gains without regressions at acceptable total cost. Unit test success and proposal generation are insufficient evidence to switch approaches.

## Follow through: observed failure repair and Memento assessment

The adapter now treats malformed JSON, invalid source contracts, worker timeout and malformed worker results as failed trials without retry or output repair. Every generated artifact is followed by an immediate ledger save. Provider charges were recorded before parsing and remain counted. Five regression tests cover the retained response 019, invalid types, continuation after failure, real worker execution, forbidden imports and worker failures. This change does not retroactively complete either archived pass. No additional paid calls were made.

```sh
python3 packages/flywheel/scripts/test-native-rrsi-contract.py
```

Memento 3 source: https://arxiv.org/html/2610.11794v1 . Its closest comparator already clears all 25 public games at 99.0 RHAE versus 100.0. Both use all public games; completion is therefore not a discriminator. The authors acknowledge model choice, reasoning budget, repeated stability and unseen evaluation matter. The rulebook ablation covers three games. No author linked implementation release was located in the inspected paper or targeted search. Do not mistake an unrelated Memento repository for this implementation.

Next experimental design, not an executed capability claim: compare unchanged MetaHarness, code model with replay, and rulebook plus code model with replay. Freeze the solver, total token and execution budget, action budget and environment families. The proposer sees only development transitions; a separate evaluator retains unseen environments. Log all failed calls and search overhead. Require at least 10% relative strict completion lift with no task family regression and known total costs before considering retention. Keep multiple replay consistent hypotheses until an observation distinguishes them: exact replay of past observations cannot establish generalization.

For deployment, the useful target is fewer failed tool actions on recurring workflows, measured against the unchanged harness. A public game ceiling score alone supplies no business performance guarantee.
