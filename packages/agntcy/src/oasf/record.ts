// SPDX-License-Identifier: MIT
//
// @metaharness/agntcy — oasf/record.ts (ADR-240 §2.2)
//
// The Open Agentic Schema Framework (OASF) capability-record shape this package
// exports: capabilities, supportedProtocols, modelRequirements, resourceEnvelope,
// securityScopes, evaluationHistory, deploymentOptions, pricingMeteringClass.
//
// This file only defines the target schema. Every field is meant to be a
// PROJECTION of facts this repo already computes (`harness score`, `harness
// genome`, `harness mcp-scan`) — see ./project.ts, which does the computing and
// enforces the "never fabricate a field" rule described below.
//
// `pricingMeteringClass` is intentionally the one field this package cannot
// populate today: nothing in harness-score/harness-genome/harness-mcp-scan
// classifies a harness's BILLING MODEL (per-invocation / per-token /
// subscription / unmetered). `estCostPerRunUsd` (harness score) is an absolute
// USD *estimate*, not a metering *class* — projecting one onto the other would
// be inventing a categorical fact this repo has no basis for. Per ADR-240
// §2.2's explicit fail-closed instruction ("if a field OASF expects has no
// existing internal source, the exporter must fail closed on that field rather
// than fabricate a plausible-looking value"), `project.ts#projectToOasf` never
// emits this field — it always reports it via `missingFields` instead. The
// type stays fully defined here so the schema honestly describes what a
// COMPLETE OASF record needs, and so a future producer (e.g. a metering
// integration) has a real field to fill in rather than a schema addition.

/** Categorical billing model OASF expects. No producer for this exists in this
 * repo yet (see file header) — `projectToOasf` never emits a value here. */
export type OasfPricingMeteringClass = 'per_invocation' | 'per_token' | 'subscription' | 'unmetered';

/** One capability the harness exposes. `kind` records which real producer the
 * capability came from — harness-genome's recommended agent/skill set, or its
 * recommended agent topology. */
export interface OasfCapability {
  id: string;
  kind: 'agent' | 'skill' | 'topology';
}

/** A host adapter this harness can run under (e.g. `'claude-code'`, `'codex'`),
 * sourced from harness-genome's recommended `plan.hosts`. */
export interface OasfSupportedProtocol {
  host: string;
}

/** Sourced from `harness score`'s `recommendedMode` + `estCostPerRunUsd`. Named
 * "requirements" by OASF; this repo's closest real signal is what mode/cost a
 * generated harness needs to run acceptably, not a formal model spec. */
export interface OasfModelRequirements {
  recommendedMode: 'CLI' | 'CLI + MCP';
  estCostPerRunUsd: number;
}

/** Derived from `harness mcp-scan`'s findings — booleans reflect whether the
 * corresponding `allow-*` finding is present in the scan (i.e. that grant is
 * actually held by the harness's MCP policy), not an assumption. */
export interface OasfResourceEnvelope {
  mcpEnabled: boolean;
  shellAccess: boolean;
  networkAccess: boolean;
  fileWriteAccess: boolean;
}

export type OasfSecurityScopeSeverity = 'high' | 'medium' | 'low' | 'info';

/** One `harness mcp-scan` finding, reprojected as an OASF security scope. */
export interface OasfSecurityScope {
  id: string;
  severity: OasfSecurityScopeSeverity;
  title: string;
}

export type OasfEvaluationMetricSource = 'harness-score' | 'harness-genome';

/** One already-computed evaluation metric (from `harness score`'s 5-dimension
 * scorecard or `harness genome`'s risk/test/publish-readiness scores). */
export interface OasfEvaluationRecord {
  metric: string;
  value: number;
  source: OasfEvaluationMetricSource;
}

/** Sourced from `harness score`'s `recommendedMode`/`archetype`/`template` plus
 * `harness genome`'s recommended `plan.hosts`. */
export interface OasfDeploymentOption {
  mode: 'CLI' | 'CLI + MCP';
  hosts: string[];
  template: string;
  archetype: string;
}

/** The full OASF capability record for one generated harness (ADR-240 §2.2). */
export interface OasfRecord {
  schema: 1;
  /** ISO-8601. Carried from `harness genome`'s `generatedAt` (the projection's
   * anchor timestamp — `harness score` does not always run alongside genome,
   * but genome is required for `capabilities`/`supportedProtocols` anyway). */
  generatedAt: string;
  capabilities: OasfCapability[];
  supportedProtocols: OasfSupportedProtocol[];
  modelRequirements: OasfModelRequirements;
  resourceEnvelope: OasfResourceEnvelope;
  securityScopes: OasfSecurityScope[];
  evaluationHistory: OasfEvaluationRecord[];
  deploymentOptions: OasfDeploymentOption[];
  pricingMeteringClass: OasfPricingMeteringClass;
}
