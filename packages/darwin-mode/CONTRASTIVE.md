# Contrastive harness development

Available from `@metaharness/darwin/contrastive` in 0.11.0. This opt-in API develops declarative harness configurations through measured comparisons. It leaves the existing `evolve` API unchanged.

```js
import {
  runContrastive,
  createContrastiveEditors,
  rememberContrastiveExperience,
  retrieveContrastiveExperiences,
} from '@metaharness/darwin/contrastive';

// executeEditor is your real Ruflo worker or model client. It returns
// {text: '{"edits":[...]}', costUsd}, enforces ceilingUsd and honors signal.
const editors = createContrastiveEditors(executeEditor);
const result = await runContrastive({
  tenantId: 'acme', projectId: 'support',
  baseline: { components: [
    { id: 'procedure', scope: 'invariant', content: { checkInputs: true } },
    { id: 'domain', scope: 'domain', content: { currency: 'USD' } },
  ] },
  task: { request: 'your development task' },
  environment: { model: 'pinned-model-id', evaluatorVersion: 1 },
  envelope: { network: false, shell: false, promotion: false },
  library: { tenantId: 'acme', projectId: 'support', entries: [] },
  budget: { maxUsd: 0.7, maxCalls: 7, timeoutMs: 30000,
    probeUsd: 0.1, proposeUsd: 0.1, composeUsd: 0.1 },
  evaluator: { surfaceAware: true, probe: executeCandidate },
  ...editors,
});
console.log(result.outcome, result.receipts, result.promotion);
```

The example requires two deployment adapters; it does not start an agent by itself. `executeCandidate` must load `input.candidate`, execute it in the declared environment, and return `{appliedDigest, score, observations, costUsd}`. Scores are finite numbers in `[0,1]`. Observations contain `{id, componentId, message}`. Keep heldout answers and production release authority outside the editor.

An edit contains `{componentId, content, citations}`. It can replace content only within its scope; it cannot add components, capabilities or dependencies. Component IDs, dependency closure, reachability, sizes, JSON shape and citation matches are validated. A composer selects a subset of supported edits, and that combination is executed before selection. Identical candidates reuse the current round's probe.

Budget admission reserves ceilings before every effect and never refunds them during a round. This favors safety over maximizing call count. Failed or malformed rounds return the baseline. Timeouts reject late results; the trusted adapter must stop its actual work. A provider response exceeding its ceiling is an invalid round with the reported charge retained in evidence.

Memory helpers produce portable, bounded experimental records. They perform no disk, network or production writes. `rememberContrastiveExperience` requires an improved candidate and matching successful probe receipt; `retrieveContrastiveExperiences` enforces tenant, project and an explicit environment key before lexical ranking. It returns at most eight records, with a four-record default. Libraries hold at most 32 entries. Applications may persist these through AgentDB/RVF and replace lexical ranking with RuVector after the same scope filter. Those integrations are not bundled or implicitly configured.

Callbacks and memory records are trusted deployment inputs, not cryptographically verified evidence. The core never evaluates embedded code. Apply OS isolation and Darwin's generated-code checks when your adapter executes scripts. Digest equality proves content identity within the adapter contract, not honesty of an external executor.

## Reproduce

From a source checkout, build and run:

```bash
npm ci --ignore-scripts
npm run build -w @metaharness/darwin
npm test -w @metaharness/darwin -- --maxWorkers=2 --minWorkers=1
node packages/darwin-mode/bench/contrastive/run.mjs --out=/tmp/contrastive.json
```

For an explicitly paid live editor smoke, set `OPENROUTER_API_KEY` in the process environment and run `node packages/darwin-mode/bench/contrastive/live-pilot.mjs --live --out=/tmp/contrastive-live.json`. It uses real provider editors and a synthetic deterministic executor. The local reservation cap is $0.25. No credentials are written to the report.

The benchmark measures mechanism correctness, operation counts, source identity and orchestration latency. It does not demonstrate general LLM improvement, production safety, or superiority over current Darwin. See [ADR-319](https://github.com/ruvnet/metaharness/blob/main/docs/adrs/ADR-319-bounded-contrastive-development.md).

## Independent confirmation in 0.12.0

A development improvement is a hypothesis. Before a deployment considers adoption, evaluate one frozen candidate against its frozen baseline on independent task pairs:

```js
import { confirmContrastive } from '@metaharness/darwin/contrastive';

const confirmation = await confirmContrastive({
  tenantId: 'acme', projectId: 'support',
  environment: { model: 'pinned-model-id', evaluatorVersion: 1 },
  envelope: { network: false, shell: false, promotion: false },
  baseline,
  candidate: developmentResult.candidate,
  developmentTaskIds: devIds,
  confirmationTaskIds: unseenIds,
  policy: { minCases: 20, minWins: 5, maxRegressions: 0,
    minGain: 0.05, alpha: 0.05 },
  budget: { maxUsd: 0.8, maxCalls: 40, pairUsd: 0.02, timeoutMs: 300000 },
  evaluator: { surfaceAware: true, evaluatePair: executePair },
});
console.log(confirmation.verdict, confirmation.stats, confirmation.promotion);
```

The deployment supplies executePair. For each input.taskId it executes both documents under identical task, model, tool and output limits, then returns tenantId, projectId, environmentDigest, envelopeDigest, taskId, appliedBaselineDigest, appliedCandidateDigest, baselinePassed, candidatePassed and costUsd. These attestations must match the input. Keep the case payload and gold answer inside the evaluator, outside editor inputs. A callback may contain multiple provider calls; its ceiling applies to their combined cost.

Both task partitions must have unique IDs with no overlap. Derive IDs from normalized input content and keep a durable dataset registry. The API cannot detect reused inputs hidden behind different IDs or data that was already present in model training.

timeoutMs bounds the entire confirmation phase. It does not reset for each pair. All declared pairs must complete before confirmation. The gate separately checks minimum case count, wins, absolute accuracy gain, allowed regressions and an exact one-sided sign test over discordant pairs. Five wins with zero losses give p = 0.03125. A tie, insufficient evidence, or forbidden regression cannot confirm a candidate.

The result includes the policy and its digest, environment and dataset digests, paired counts, receipts and costs. It always returns promotion: not-authorized. Scope and digest checks attest identity; they are not cryptographic proof that a dishonest callback executed the claimed task.

Freeze the candidate, thresholds and set before evaluation. Reusing confirmation failures to tune the next candidate invalidates the same set as fresh evidence. Independent task pairs and a prespecified test are statistical assumptions. Multiple candidates or repeated tests require a separate multiplicity policy and fresh data. Production authorization and security checks remain deployment responsibilities.

For the pinned public intent-classification experiment, see bench/confirmation. Equal spending ceilings do not establish identical actual spend; the report gives both caps and measured costs.


### Measured 0.12.0 pilot

In one frozen public CLINC150 subset (24 development and 40 unseen confirmation requests), development accuracy improved from 23/24 to 24/24. Baseline, candidate and control each scored 38/40 on confirmation; both paired superiority tests returned p = 1 and rejected. Candidate inference cost increased 15.68% in this run. Keep the baseline. Total provider usage reported $0.007642223 for 253 requests, with $0.596 conservatively reserved against a $1 cap. This small public experiment does not establish general model or agent gains. Full evidence is attached to the darwin-v0.12.0 GitHub release.
