// SPDX-License-Identifier: MIT
//
// @metaharness/aws-finops — Darwin FinOps harness (ADR-168).
//
//   model_frozen = true ; harness_evolves = true ; live_infra = never_touched
//
// The Darwin Shield primitives (ADR-155/167), re-pointed from defensive security to
// AWS cost optimization. Swap the oracle: semgrep + crash-fuzzer → infracost +
// checkov + terraform validate/plan. A frozen $0.04 Qwen proposes a Terraform patch;
// a DETERMINISTIC ORACLE proves the modeled bill drops without breaking the build or
// compliance; only verified savings are reported, behind a human review gate; the
// residual modeled bill shrinks each generation.
//
// Modules:
//   types            — the domain contract (CostReport, OptimizationProposal, oracle, residual)
//   core             — rounding primitives (dependency-free)
//   infracost-adapter— infracost JSON → normalized CostReport / signed CostDelta
//   checkov-adapter  — checkov JSON → normalized PolicyReport + compliance non-regression
//   oracle           — the deterministic cost oracle (build + compliance + savings + evidence)
//   residual         — shrinking residual modeled bill + loop terminal condition
//   cascade          — multi-tier cheap→frontier→oracle cascade (injected lanes)
//   binaries         — optional infracost/checkov/terraform detection (skip-when-absent)

export * from './types.js';
export * from './core.js';
export * from './infracost-adapter.js';
export * from './checkov-adapter.js';
export * from './oracle.js';
export * from './residual.js';
export * from './cascade.js';
export * from './binaries.js';
