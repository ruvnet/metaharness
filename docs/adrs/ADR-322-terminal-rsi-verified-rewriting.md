# ADR 322: Verified development trajectory rewriting

Status: Proposed, implemented and locally validated

Date: 2026-10-26

Base: d59130b3649c2906a020b3a1aad53cfd10727897

## Research and decision

Primary source: [Terminal RSI, arXiv 2610.22192v1](https://arxiv.org/html/2610.22192v1),
especially sections 2.1, 2.2, 2.4 and 5. Verified rewriting requires fresh execution after leakage
review. Success prioritized reward separates bounded partial credit from strict completion. The paper
explicitly leaves matched compute alternation, isolated TB GAE effects, online reward controls and
critic inheritance ablations unresolved. Its Rust and C case also exposes an architectural requirement
that output checks did not enforce. These results motivate verifier coverage and protected confirmation,
not claims of universal recursive improvement.

Implement verified rewriting and diagnostic reward in `@metaharness/flywheel`. Reuse its existing
Proposer, Evaluator, promotion gates, signed receipts and replay verification. Do not change the
default gate. Keep the model frozen. Defer PPO, learned critic transfer and TB GAE to a separate
training backend with appropriate policy and value access. The existing turn credit package remains
unchanged; its offline advisory estimator is not TB GAE.

## Specification

Input: an explicitly public development task, approved public steps, a snapshot SHA256 digest,
independently verified discovery outcome, trusted adapter callbacks, replay count, cost budget,
and cancellation signal.

Output: accepted runbook or structured rejection with task and runbook digests, completed replay
outcomes, session identifiers and reported cost. An accepted runbook becomes a proposal through
the existing Flywheel seam. It cannot authorize its own promotion.

Business value: reuse successful procedures across executions while preventing partially passing
check suites from masquerading as completed work. Replay costs must be included in experiment
budgets. The cost per win adapter covers evaluation costs only; it does not claim discovery or
rewriting costs are free.

Assumptions: callbacks are trusted host code; public trace content is independently approved;
the environment provider enforces isolation; the verifier is outside the actor's writable domain;
confirmation and anchor suites never enter rewriting. A split label alone cannot audit task overlap.

## Control flow and invariants

1. Validate and explicitly project the public task. Freeze the task and step array. Extra properties
   such as raw trace, credentials, and protected tests are never forwarded to callbacks.
2. Require strict safe discovery before rewriting. Independent review must return exact true.
3. Open a fresh snapshot per replay. Reject duplicate session identifiers or mismatching digests.
4. Execute, run the protected verifier, validate its outcome, account for cost, and reject any strict
   failure, safety violation, cancellation or overrun. Close every returned session in a finally block.
5. Only after every replay succeeds, offer the runbook as a policy mutation. Existing evaluation,
   anchor and receipt machinery determines whether it promotes. Rejected proposals preserve the parent.

Success invariant: accepted implies every required replay produced strict safe completion within
the reported budget and every returned session closed successfully. Failure walk: a run passes all
scenario checks but fails the terminal gate; it receives diagnostic partial credit, produces no
accepted runbook, and cannot inflate primary completion through this adapter.

## Scoring

Diagnostic SPR is `S + P / (P + D)` with valid reports and positive frozen family divisor D, otherwise
binary S. Safety violations remove the success term. Use an algebraically equivalent ratio to avoid
denominator overflow and cap numerical saturation below one. This preserves per trajectory ordering;
it does not prove that maximizing expected shaped reward maximizes completion probability.

Promotion primary is strict safe success fraction, paired outcomes are strict safe booleans, and
cost per win is total evaluation cost divided by strict wins. Zero wins uses finite MAX_VALUE as a
sentinel compatible with the existing finite evidence gate. No op rate is the floor zero rather than
an invented estimate of whether a failed task did useful work. At that floor, the unchanged gate
requires completion lift or lower cost per win and preserves its safety and anchor checks.

## Architecture and trust review

There is no execution or shell interpolation in the core. All host execution is injected through
trusted adapters. Outputs are bounded in size, counts and costs validated, and exception messages
are not returned because they may include private verifier data. The library does not attempt regex
secret detection as a substitute for an independent public content review.

Session IDs and snapshot digests are consistency checks, not environment attestation. A malicious
reviewer, verifier or provider can fabricate outcomes. The existing external trusted identity policy
still applies to promotion receipt signers. Callbacks must enforce hard time and spend limits and
honor AbortSignal; cooperative cancellation cannot kill an uncooperative process. Costs from failed
adapter executions may be unknown and must be recorded by the host. No production hosts, API secrets
or paid inference were used in this validation.

Alternative: a separate evolution engine duplicates gates and provenance with greater maintenance
cost. Alternative: full model training requires model values and training infrastructure and has
unproven marginal value here. Alternative: promote by partial reward risks verifier gaming.

Rollback: remove the opt in proposer from the caller. Legacy evaluators, default gates and existing
promotion data formats remain unchanged. No migration or package dependency is introduced.

## Validation and acceptance

Validation toolchain: Node v24.22.1, TypeScript 5.9.3, Vitest 4.1.12, Node 20 type declarations.
An existing root lockfile inconsistency makes `npm ci` fail on missing native kernel platform
entries. Validation used an isolated toolchain and workspace links; dependency manifests and the
repository lockfile were unchanged. Full monorepo validation is not claimed.

Scoped security scan: `npx -y @claude-flow/cli@3.25.6 security scan --target
packages/flywheel/src/verified-rewrite.ts --depth deep --type all`, run on 2026-10-26, returned
zero findings at every severity. This is a source scan of the new module, not a dependency or
production security certification. The scanner did not expose an advisory feed timestamp.
Repository lockfile SHA256: `b163bbb0efda05b10a35faa68f9e5f9c3fd61bc5ad8eecd3ee03e426b9456794`.
Manual review checked protected verifier placement, callback trust, public field projection,
malformed numeric evidence, exception output suppression, cancellation and cleanup. Residual
adapter trust and cooperative cancellation limits are recorded above.

| Requirement | Executable evidence |
| --- | --- |
| Strict success dominates partial progress | Saturation, invalid report, malformed input and strict score tests |
| Independent review precedes execution | Review rejection opens zero sessions |
| Development only and explicit projection | Runtime split rejection, extra private properties excluded, frozen callback input |
| Fresh replay and fail closed cleanup | Duplicate ID, snapshot mismatch, execute/verify/cleanup failure tests |
| Reported replay budget and cancellation | Exact budget, early exhaustion, final overrun and cancellation tests |
| Existing gate retains authority | Real Node file repair, separate unseen confirmation and anchor inputs, signed receipt replay |
| Partial progress cannot promote | All scenario checks passing with strict failure yields zero promotions |
| Existing consumers unchanged | Flywheel 198 tests and turn credit 20 tests passing |
| Export compatibility | ESM and CJS dual load, identical frozen gate fingerprint |

The process fixture includes a frozen retry control and independent temporary directories. Its
deterministic repair mapping validates integration, not an LLM self improvement claim. A live trial
remains necessary before default enablement: freeze 100 unseen tasks, pair three runs per arm for
baseline, runbook proposer, and equal budget retry control. Account for discovery, rewriting, replay
and evaluation. Keep confirmation results outside the proposer and select on a separate validation
set. Require at least 10% relative strict completion improvement, paired uncertainty excluding zero,
no security regression, and no increase in total cost per verified completion. One hundred tasks
may be underpowered for small differences; report an inconclusive result rather than relaxing the gate.

Local mock adapter overhead: 2000 measured iterations after 100 warmups, eight replays each, about
15.19 microseconds per rewrite cycle and 0.142 microseconds per diagnostic reward plus score pair.
These include no model calls, containers or I/O. Early rejection executes one of eight replay
sessions, avoiding 87.5% of replay sessions for an immediately failing runbook. These measurements
characterize local orchestration only and are not production latency or model capability claims.

Reproduce with the four commands in the package README. Machine readable benchmark output is
in `docs/validation/terminal-rsi-local-benchmark.json`.
