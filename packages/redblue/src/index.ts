// SPDX-License-Identifier: MIT
//
// @metaharness/redblue — MetaHarness Adversarial Operators (Red/Blue Team Harness).
//
// Public API. See README.md for the SAFETY BOUNDARY (enforced in config/safety.ts).

export * from './types.js';

// Config + safety
export {
  loadConfigFromString,
  buildConfig,
  parseYaml,
  defaultConfig,
  ALL_FAMILIES,
} from './config/loader.js';
export {
  SafetyViolationError,
  enforceSafetyLimits,
  validateTarget,
  assertNoLiveCredential,
  redact,
  redactAll,
  HARD_SAFE_DEFAULTS,
} from './config/safety.js';

// Models
export { OpenRouterClient, hasApiKey } from './models/openrouter.js';
export { MockModelClient } from './models/mock.js';

// Attacks
export { generateFamily, generateSuite, resetIds, FAMILY_META } from './attacks/families.js';
export {
  MockTargetDriver,
  HttpTargetDriver,
  PatchedTargetDriver,
} from './attacks/sandbox.js';

// Actors
export { mutateProbe } from './actors/red.js';
export { generatePatches, resetPatchIds, BLUE_ROLES } from './actors/blue.js';

// Judges + severity
export { judge, parseVerdict, extractJson, validateVerdict } from './judges/judge.js';
export { mockMarkerJudge } from './judges/mock-judge.js';
export {
  severityScore,
  severityBand,
  shouldBlockProduction,
  bandRank,
  SEVERITY_WEIGHTS,
} from './judges/severity.js';

// Runner
export {
  runBaseline,
  patchAndRetest,
  computeRates,
  failureReduction,
} from './runner.js';
export type { RunOptions, BaselineRun, PatchRetestResult } from './runner.js';

// Reports
export { buildReport, renderMarkdown } from './reports/report.js';

// Example targets
export {
  exampleAgentTarget,
  alwaysVulnerableFixture,
  vulnerableMockTarget,
  EXAMPLE_AGENT_SYSTEM_PROMPT,
} from './mock-target.js';
