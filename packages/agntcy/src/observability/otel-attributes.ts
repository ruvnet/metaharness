// SPDX-License-Identifier: MIT
//
// @metaharness/agntcy — observability/otel-attributes.ts (ADR-240 §2.3)
//
// AGNTCY's OpenTelemetry semantic-convention extension defines ten span
// attributes for agent execution: agent.identity, agent.capability,
// agent.intent, agent.parent, coordination.episode, authorization.decision,
// model.route, memory.provenance, evaluation.score, receipt.hash.
//
// This package (MetaHarness build-time, ADR-240) owns and exports constants
// for EIGHT of them. The remaining two — `coordination.episode` and
// `authorization.decision` — are populated at RUNTIME by RuFlo's SLIM/CASA
// integration (companion ruflo ADR-380) and are deliberately NOT exported as
// constants here: a harness running standalone (no RuFlo) has no real value
// for either attribute, and ADR-240 §2.3 is explicit that they must be
// omitted rather than fabricated. Their key strings are documented below only
// so a caller wiring both halves together can see the full ten-attribute
// convention in one place; this package's constants list stops at eight.
//
// No `@opentelemetry/api` (or any OTel SDK) dependency is added here — this
// repo has none today (`Dependency-free (Node built-ins)`, see package.json),
// and these are just the semantic-convention attribute KEYS. A caller that
// already depends on an OTel SDK attaches these as span attribute names; a
// caller that doesn't can still use them as plain object keys (see
// map-existing-telemetry.ts).

/** Span attribute value types OTel accepts (string | number | boolean | arrays
 * of same) — this package never needs the full OTel `AttributeValue` union. */
export type OtelAttributeValue = string | number | boolean;
export type OtelAttributes = Record<string, OtelAttributeValue>;

// --- the 8 attributes this package (MetaHarness / build-time) owns ----------

/** W3C DID or equivalent identity subject for the executing agent (ADR-240 §2.1). */
export const AGNTCY_ATTR_AGENT_IDENTITY = 'agent.identity';
/** One capability/badge the agent is exercising (tool-policy-derived, ADR-240 §2.1). */
export const AGNTCY_ATTR_AGENT_CAPABILITY = 'agent.capability';
/** The stated objective/intent this span is executing under (ADR-240 §4). */
export const AGNTCY_ATTR_AGENT_INTENT = 'agent.intent';
/** The parent agent/session identity, for multi-agent call trees. */
export const AGNTCY_ATTR_AGENT_PARENT = 'agent.parent';
/** Which model candidate a routing decision selected (@metaharness/router). */
export const AGNTCY_ATTR_MODEL_ROUTE = 'model.route';
/** Which memory tier/key a retrieved fact's provenance traces to (ADR-161). */
export const AGNTCY_ATTR_MEMORY_PROVENANCE = 'memory.provenance';
/** The evaluation score (Score.primary, ADR-072 `meetsPromotionRule`) for this run. */
export const AGNTCY_ATTR_EVALUATION_SCORE = 'evaluation.score';
/** Hash/signature of the run's receipt (ADR-011 witness / flywheel PromotionReceipt). */
export const AGNTCY_ATTR_RECEIPT_HASH = 'receipt.hash';

/** The eight AGNTCY OTel attribute keys this package owns, in one array. */
export const AGNTCY_OWNED_OTEL_ATTRIBUTES = [
  AGNTCY_ATTR_AGENT_IDENTITY,
  AGNTCY_ATTR_AGENT_CAPABILITY,
  AGNTCY_ATTR_AGENT_INTENT,
  AGNTCY_ATTR_AGENT_PARENT,
  AGNTCY_ATTR_MODEL_ROUTE,
  AGNTCY_ATTR_MEMORY_PROVENANCE,
  AGNTCY_ATTR_EVALUATION_SCORE,
  AGNTCY_ATTR_RECEIPT_HASH,
] as const;

export type AgntcyOwnedOtelAttribute = (typeof AGNTCY_OWNED_OTEL_ATTRIBUTES)[number];

// --- the 2 attributes owned by the companion ruflo ADR-380 side ------------
//
// Documented, NOT exported for population by this package. Emitting either of
// these from a standalone-harness (no RuFlo) context would be fabricating a
// coordination/authorization fact this package cannot observe.

/** Owned by ruflo ADR-380 (RuFlo SLIM/CASA runtime). Not emitted by this package. */
export const RUFLO_ADR324_ATTR_COORDINATION_EPISODE = 'coordination.episode';
/** Owned by ruflo ADR-380 (RuFlo SLIM/CASA runtime). Not emitted by this package. */
export const RUFLO_ADR324_ATTR_AUTHORIZATION_DECISION = 'authorization.decision';
