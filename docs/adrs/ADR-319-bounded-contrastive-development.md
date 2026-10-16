# ADR-319: Bounded contrastive harness development

Status: accepted for an opt-in experimental API. Date: 2026-10-16.

## Outcome and scope

Add `@metaharness/darwin/contrastive`: two evidence-scoped editors, actual candidate probes, selective composition, bounded experiment memory and a caller-owned editor bridge. Existing Darwin CLI/evolve behavior is unchanged. The business goal is fewer repeated failures without paying for exploration on every task.

Inputs are a declarative harness, task, environment, immutable capability envelope, scoped library, explicit budgets and trusted execution adapters. Outputs are a selected development candidate, execution fingerprints, receipts and costs. No module may publish, promote, execute embedded code, obtain credentials or start agents itself.

The design is an original MIT implementation informed by [Harness²](https://arxiv.org/abs/2610.14224) and its [reference release](https://github.com/google-research/harness2). No upstream source was copied. Its similarly named Meta-Harness baseline is a separate project.

## Control flow

1. Validate and freeze all serializable inputs. Reject a surface-independent evaluator.
2. Reserve the complete per-call ceiling before a baseline execution.
3. Produce separate invariant and domain edits grounded in component-matching observation IDs. No development score is passed to editors.
4. Execute the candidate under the same frozen task and environment. Match the adapter's applied digest to the candidate digest. Reuse identical configurations within this round.
5. If both scopes improved, ask the composer to select only already supported edits. Execute that combination; retain the better individual if composition regresses.
6. On malformed data, timeout, exceeded admission budget or adapter failure, return the baseline. No automatic retries or production state changes.
7. Optionally retain the improved executed document as an experimental memory record. Retrieval filters tenant, project and environment before lexical ranking. Later tasks start from their caller's baseline.

## Architecture and trust

`engine.ts` owns admission and selection. `validation.ts` owns JSON bounds, schema, component dependencies, evidence and fingerprints. `editors.ts` bridges a real model client or Ruflo executor callback. Ruflo task records alone are not execution. `memory.ts` creates portable immutable records; persistence and RuVector indexing are deployment responsibilities.

Sequential admission is deliberate: this first release favors unambiguous cancellation and spend accounting over concurrent provider work. Digest reuse avoids redundant probes. Monetary ceilings use integer nanodollars. Unknown-cost failures retain the reservation; known over-ceiling charges are recorded honestly and invalidate the round.

A digest echo is trusted adapter attestation, not cryptographic proof of execution. Callbacks run in the same process and must enforce actual provider limits, cancellation, tenant authentication and any OS isolation. Timeout stops acceptance of late results; it cannot forcibly stop a dishonest callback. JSON validation does not certify script content. Any adapter executing generated code must apply existing Darwin safety gates and an appropriate OS sandbox.

The library is data, not authority. Entries cannot expand capabilities or authorize promotion. Retrieval rejects unknown schema fields and invalid promotion/status values. Free-form content remains untrusted. Protect stored records with deployment access controls; a content digest does not authenticate its author.

## Acceptance and evidence

| Requirement | Evidence command or case |
| --- | --- |
| Candidate affects execution | Parser adapter reads the supplied components; wrong digest rejected |
| Immutable scope and safety | Frozen callback inputs; cross-scope and capability edits rejected |
| Admission before effects | Seven-call success and six-call fallback; exact decimal boundary test |
| No late-result adoption | Timeout and late promise tests |
| Evidence constrained composition | Invalid citations, unsupported edits and regressing composition tests |
| Memory isolation | Tenant/project/environment checks and extra grading-field rejection |
| Usable provider integration | Live provider editors with a deterministic synthetic executor |
| Reproducibility | Source/build manifest, 100 unseen generated inputs and 32 control seeds |

Run `npm run build -w @metaharness/darwin` then `npm test -w @metaharness/darwin -- --maxWorkers=2 --minWorkers=1`. Run `node packages/darwin-mode/bench/contrastive/run.mjs --out=/tmp/contrastive.json` for the synthetic mechanism benchmark. Live editor smoke is separately opt-in: `node packages/darwin-mode/bench/contrastive/live-pilot.mjs --live --out=/tmp/contrastive-live.json` with an authorized `OPENROUTER_API_KEY` in the environment.

The baseline and sampling controls use the same synthetic task generator. Equal logical operations are not equal real inference dollars. These results do not establish improvement over current Darwin on real agent tasks, general transfer, or the proposed five-point real-task gate. A production performance claim still requires an independent, preregistered real-task comparison with total measured inference costs.

## Release and rollback

Release this additive API as `@metaharness/darwin@0.11.0`, with the existing default path preserved. Publish only the reviewed tarball after type checks, package regression tests, adversarial checks, production dependency audit and fresh-install smoke. Bind the release evidence to its source commit and npm integrity. Rollback is version pinning to `0.10.3`; no storage migration or production promotion occurs automatically.
