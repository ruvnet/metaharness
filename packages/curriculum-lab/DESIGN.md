# Experiment harness contract and acceptance

Status: draft; no budget or live execution authorization. Base: e0dfd44da72b7adfb7c57fdd42d124be58ed7086. Owner: ChatGPT package lane; existing Arena driver stays with ruvultra.

SPARC specification: prepare and review bounded environment-learning experiments, persist negative results and uncertain operations, isolate provider secrets, and expose honest completion state. No environment verifier edits, paid resource allocation, promotion, package publication or Arena POST.

Control flow: validate registration → choose one bounded parameter → host review → reserve resources → immutable intent → provider operation → sanitized immutable receipt → independent evaluator → unsigned review. Any uncertain outcome stops that operation; restart reuses the receipt or requires reconciliation. CPU smoke can run without providers.

Architecture choice: small dependency-free ESM host package with optional exact Darwin peer and reviewed Python execution boundary. Existing numeric ShellEvaluator inherits the entire environment, so it is not used for credential-bearing orchestration. Provider APIs remain fixed-origin, redirects denied, no provider-selected log URL fetch. Credential loader is separate from trainer process. The existing Portfolio HF runner is not copied or retried; its known compatible request settings inform the adapter.

Requirement/evidence map:

| Requirement | Verification |
| --- | --- |
| No seed/family overlap | registration rejection tests |
| One supported mutation | bounds tests and actual repository Darwin mutator |
| Fixed denominator; contaminated cells excluded | truncation/missing/duplicate episode tests |
| No synthetic promotion | synthetic review returns HOLD, all reviews promote:false |
| No duplicate spend after uncertain outcomes | intent, failure reuse, corruption and concurrent writer tests |
| Durable aggregate reservations | exhausted/mismatched budget tests |
| Provider boundary | mocked HF and Vast request contracts, no raw secrets in retained receipts |
| Host credential isolation | protected binding ownership/mode/symlink/duplicate tests; empty child environment |
| Actual executable learning smoke | Python REINFORCE through pinned runner, immutable receipt reuse |
| Live Qwen learning/transfer | BLOCKED: reviewed trainer/evaluator, running owner-approved GPU and budget |
| rGi and signed Flywheel/Autogenous | NOT INTEGRATED; remains required before promotion |

Rollback: discard this isolated draft package and its private test directory. Existing Arena source and driver are unchanged. No state migration or service deployment.
