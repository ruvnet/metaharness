# Independent confirmation release evidence

Version: @metaharness/darwin 0.12.0. Date: 2026-10-16 UTC.

The new confirmation API tests a frozen candidate against a frozen baseline on disjoint task IDs under a frozen policy. It returns an evidence verdict and never authorizes promotion. Scope and execution digests must match. All declared pairs must complete within one total deadline and conservative monetary reservations. The one-sided exact paired test is evaluated only after the declared set completes.

## Observed public benchmark

One prespecified CLINC150 pilot used 24 development utterances and 40 separate confirmation utterances across eight finance intents. Dataset provenance, model, provider route, budgets, source hashes and comparison policies were frozen before the first model call. Candidate documents were frozen before confirmation. There was one live run and no tuning or rerun after confirmation.

| Measure | Baseline | Contrastive candidate | Control |
| --- | ---: | ---: | ---: |
| Development correct | 23/24 | 24/24 | 23/24 |
| Confirmation correct | 38/40 | 38/40 | 38/40 |
| Cost of 40 confirmation predictions | $0.001085832 | $0.001256124 | $0.001085832 |

Both superiority comparisons had zero paired wins, zero losses and p = 1. Both rejected with insufficient-wins. The control selected the unchanged baseline, so its confirmation predictions were shared and billed once. The candidate cost 15.68% more for the same observed accuracy. Keep the baseline. This experiment demonstrates a failed transfer of development gain; it does not demonstrate general accuracy improvement.

Total provider usage reported $0.007642223 for 253 requests. Conservative client reservations totaled $0.596 against a $1 ceiling, with zero unresolved attempts. Requested route: google-vertex/eu, model google/gemini-2.5-flash-lite. Actual usage charges and reserved ceilings are different quantities.

This is a small public subset, potentially seen during pretraining. It is not the full CLINC150 benchmark or a general agent evaluation. Statistical assumptions include independent pairs and prespecified candidates and policies. Repeated experiments require additional error control.

## Verification

830 tests passed, 19 existing skips. This includes 99 focused confirmation tests. Clean installation, TypeScript compilation, deterministic adapter checks and production dependency audit passed. The production npm audit reported zero vulnerabilities at audit time. The independent security review is in packages/darwin-mode/bench/confirmation/security-review.md.

Source/build hash for the live experiment: cc99a5833a39f2f6d9533faac08f249cbfd8cef54e31bc6e8dea97082d7b19eb. Local run source commit: 7b7cb54bc5afae0ee9a6a690b632ccc8662ce5ab. The freeze asset lists individual source and distribution file hashes, allowing verification against the published source tree.

The GitHub release attaches full freeze, candidate and result JSON files. live-benchmark-summary.json records their hashes and costs. validation.json records verification scope. The final package acceptance is also attached to the release.

## Consumer acceptance test

In a fresh temporary project, install @metaharness/darwin@0.12.0 and copy acceptance.mjs into that project, then run node acceptance.mjs. It executes 20 paired cases through the installed API, confirms six wins with p = 0.015625, rejects a mismatched execution envelope and verifies that promotion remains unauthorized. This is an API acceptance test with a deterministic evaluator, not a model performance claim.

## Repository CI

The package release is independently validated. PR #407 remains unmerged because existing Rust dependency resolution fails on Candle 0.8 and yanked zip 1.x. Issue #408 tracks that blocker. This release does not claim Rust workspace CI or cargo audit success.
