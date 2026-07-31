// SPDX-License-Identifier: MIT
//
// @metaharness/agntcy — AGNTCY (Cisco Outshift / Internet of Cognition) build-time
// integration for generated MetaHarness agents. See docs/adrs/ADR-240-agntcy-identity-oasf-observability.md
// for the full decision record and docs/adrs/ADR-002-kernel-boundary.md for why this
// ships as an optional peer package rather than a kernel dependency.
//
// This is scaffolding only. The package builds and passes CI as-is, but exports
// nothing yet — sibling contributors own the following subpaths, added in parallel:
//
//   - ./src/identity/  — ADR-240 §2.1: W3C DID minting, verifiable-credential badges
//                         derived from the mcp-scan tool-policy allowlist, and the
//                         signing hook into the existing ADR-011 witness manifest.
//                         Identity-provider calls MUST be a clearly-logged, clearly-
//                         erroring stub behind a feature flag/config check until a
//                         real AGNTCY identity-provider SDK exists on npm — none does
//                         today under any guessed name (verified 404 on every
//                         plausible package name; see README.md "Status" section).
//
//   - ./src/oasf/       — ADR-240 §2.2: Open Agentic Schema Framework capability-record
//                         export (projection of already-computed harness-score /
//                         harness-genome / harness-mcp-scan facts, never invented
//                         values) and AGNTCY Directory publishing. Directory publish
//                         is a config-gated network stub for the same reason as above.
//
//   - ./src/casa/       — ADR-240 §4: the CASA intent-to-authority-envelope compiler.
//                         Deterministic, schema-validated free-text-objective ->
//                         { allow, deny, budget_usd, expires_at } compilation. The
//                         compiler MAY use an LLM for the translation step; the
//                         compiled envelope and its schema validation MUST be pure,
//                         deterministic code. This package compiles envelopes; it
//                         never enforces them — enforcement is owned by the runtime
//                         (see companion ruflo ADR-380).
//
// Once those subpaths land, this file re-exports their public surface. Until then,
// importing "@metaharness/agntcy" is well-defined (loads, has no side effects) but
// intentionally empty.

export * as identity from './identity/schema.js';
export * as identityBadges from './identity/from-mcp-scan.js';
export * as identityWitness from './identity/sign.js';

export * as oasf from './oasf/record.js';
export * as oasfProject from './oasf/project.js';
export * as oasfPublish from './oasf/publish.js';

export * as observability from './observability/otel-attributes.js';
export * as observabilityMap from './observability/map-existing-telemetry.js';

export * as casa from './casa/index.js';
