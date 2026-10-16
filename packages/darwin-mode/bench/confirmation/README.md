# Independent CLINC150 confirmation pilot

This benchmark measures a real model classifying public human utterances. It does not promise that prompt editing improves accuracy. An unchanged candidate, regression, rejection, or statistically inconclusive result is valid.

## Data and attribution

Source: [CLINC oos-eval](https://github.com/clinc/oos-eval), accompanying Stefan Larson et al., [An Evaluation Dataset for Intent Classification and Out-of-Scope Prediction](https://aclanthology.org/D19-1131/), EMNLP 2019.

The frozen subset is derived from the official dataset under [Creative Commons Attribution 3.0 Unported](https://creativecommons.org/licenses/by/3.0/). The upstream license is reproduced in CLINC-LICENSE.txt. The only changes are deterministic row selection and adding row IDs; utterances and labels are preserved.

Pinned repository commit: 828f8093932c8fe6ca7936c3d2e52903b1c523de.
Pinned data/data_full.json SHA256: 36923c3705a59e08fe9c3883d8bc2dd966ef93e22cb78ac41171782a698d56e0.

Eight related financial intents are fixed before model calls: balance, bill_balance, bill_due, min_payment, pay_bill, transactions, spending_history, and income. Each contributes three official validation examples and five official test examples, selected by a fixed SHA256 ranking. The result is 24 development and 40 confirmation cases. Exact and normalized utterance overlap is rejected. Gold labels stay inside trusted evaluators; editors receive development utterances and failure observations without reference labels.

CLINC150 is public and may have appeared in model training. These confirmation cases are unseen by this experiment's editors, not proven unseen during model pretraining.

## Frozen experiment

The baseline already has useful intent definitions, disambiguation guidance, and an exact JSON output contract. It is not deliberately weakened.

The contrastive arm uses real scoped model editors and the source-bound evaluator. The control generates three independent complete prompt candidates and chooses the best development accuracy, with ties retaining the earliest candidate. Each development arm has the same $0.252 client reservation ceiling, comprising at most 96 classifications and three editors. Actual spend is measured and can differ.

Before any paid request, the runner writes source and build hashes, dataset IDs, taxonomy, baseline, model, budgets, and policies to a freeze manifest. After development, selected candidate documents and digests are written before confirmation. No candidate is selected or revised using confirmation outcomes.

Two paired comparisons are declared:

1. Contrastive candidate versus frozen baseline.
2. Contrastive candidate versus independently selected control.

Each uses alpha 0.025, Bonferroni correction for the two comparisons. Both must confirm before superiority is recorded. The policy requires all 40 cases, at least six paired wins, zero paired regressions, and at least 0.05 accuracy gain. With a strong baseline and only 40 cases this gate can have little power; absence of confirmation is not proof of equivalence. No result authorizes promotion.

## Provider and cost envelope

The model is google/gemini-2.5-flash-lite, temperature zero. Requests pin the google-vertex/eu endpoint using both order and only, disable fallbacks, require supported parameters, and bound price. The catalogue and endpoint must match $0.10 per million input tokens and $0.40 per million output tokens. Responses must identify the same model and Google provider.

Task responses allow 96 output tokens; editor responses allow 1200. Every attempt reserves its maximum allowance before dispatch. Accounting uses integer nanoUSD. There are at most four concurrent requests, no retries, a 90 second request timeout, a 20 minute client deadline, and a five minute total deadline for each paired confirmation gate.

Maximum planned requests: 318. Maximum planned reservation: $0.744, under the absolute $1 client cap. Each classification reserves $0.002 and each editor $0.02. The client cannot enforce an external provider's billing system; finite overspend or unknown costs abort the experiment and remain visible in evidence.

Fresh confirmation predictions are cached by frozen environment, capability envelope, candidate digest, and task ID. Development predictions are never reused in confirmation. Shared confirmation predictions are billed once in the overall ledger. Per-arm costOfPredictionsUsedUsd reports the measured cost of the predictions used, while costByStage reports incremental billed cost. Shared predictions are not free inference.

## Run and verify

From the repository root, build the Darwin package, then run:

    node packages/darwin-mode/bench/confirmation/offline.mjs

Offline checks forbid network access and use labeled fake outputs only as contract tests. They verify dataset reconstruction when source bytes are available, disjoint normalized inputs, response validation, no gold or holdout IDs in editor requests, unchanged-candidate rejection, provider concurrency, and budget admission.

The public frozen subset is already included. To reconstruct it in a fresh directory, run dataset.mjs --prepare. It verifies the complete upstream data and license hashes and refuses to overwrite an existing freeze.

The live runner requires an explicitly supplied OPENROUTER_API_KEY and explicit opt-in:

    node packages/darwin-mode/bench/confirmation/run.mjs --live

Run it only after authorization and offline verification, using a sanitized process environment. It never reads a secret file or prints credentials. A one-shot lock prevents this experiment being rerun on the same executor. All manifests, candidate freezes, results, and failure receipts go to /tmp. Do not delete the lock and retry after observing confirmation.

Report development costs separately from confirmation inference costs, all three measured accuracies, both paired gates, provider metadata, latency, and source hashes. Same-process callback separation is not a sandbox against malicious adapters.
