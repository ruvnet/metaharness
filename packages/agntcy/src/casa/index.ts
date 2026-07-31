// SPDX-License-Identifier: MIT
//
// @metaharness/agntcy — CASA intent-to-authority-envelope compiler
// (ADR-240 §4). Compile-time only: this package never enforces an
// envelope against a live invocation. See schema.ts and compile.ts for the
// full load-bearing invariant (translation may eventually use an LLM,
// enforcement — in the companion `ruflo` repo — never does).

export type { CasaEnvelope, CasaScope } from './schema.js';
export {
  CasaEnvelopeValidationError,
  validateCasaEnvelope,
  parseCasaEnvelope,
  isCasaEnvelope,
} from './schema.js';

export type { CasaTranslator, CompileObjectiveOptions } from './compile.js';
export {
  compileObjectiveToEnvelope,
  DANGEROUS_SCOPES,
  DEFAULT_BUDGET_USD,
  DEFAULT_TTL_MINUTES,
} from './compile.js';
