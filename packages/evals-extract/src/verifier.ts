// @metaharness/evals-extract — the DOC-TYPE-SPECIFIC VERIFIER STACK.
//
// The verifier returns an AGREEMENT signal used by routing (escalate on disagreement) + calibration. It is
// deliberately NOT a generic "critic says yes" model — ADR-226 measured that read-only strong advice added
// ZERO marginal resolves at 5.4x cost. The useful lever is EXECUTOR policy + real checks: json-schema
// validation, per-field type checks, required-field presence, cross-field consistency — all deterministic,
// cheap, and doc-type-appropriate. Each check returns [0,1] agreement; the mode selects which check(s) run.
import type { DocType, VerificationMode } from './genome.js';
import { validateSchema, typeMatches, canonicalJson, type JsonSchema } from './normalizer.js';

export interface VerifyInput {
  docType: DocType;
  schema: JsonSchema;
  /** The normalized candidate extraction. */
  value: Record<string, unknown> | null;
  /** Additional sampled extractions (for multi-solver / self-consistency agreement). */
  samples?: (Record<string, unknown> | null)[];
}

export interface VerifyResult {
  /** [0,1] — how much the verifier stack agrees the extraction is sound. */
  agreement: number;
  /** True when the stack actively disagrees (agreement below a floor) → a routing escalation trigger. */
  disagrees: boolean;
  checksRun: string[];
}

/** Injectable domain verifier for the live run (e.g. a business-rule checker). The default is a structural
 *  approximation so the adapter runs at $0 for replay; a real check is strictly better. */
export type DomainChecker = (docType: DocType, value: Record<string, unknown>) => number | undefined;

export function makeVerifier(opts: { domain?: DomainChecker } = {}) {
  return function verify(mode: VerificationMode, input: VerifyInput): VerifyResult {
    if (mode === 'none' || input.value === null) {
      return { agreement: input.value === null ? 0 : 0.5, disagrees: input.value === null, checksRun: [] };
    }
    const checks: string[] = [];
    const scores: number[] = [];

    if (mode === 'jsonSchemaValidate') {
      scores.push(validateSchema(input.value, input.schema, 'strict') ? 1 : 0.1);
      checks.push('jsonSchemaValidate');
    }
    if (mode === 'typeCheck') {
      scores.push(typeAgreement(input.value, input.schema));
      checks.push('typeCheck');
    }
    if (mode === 'requiredFields') {
      scores.push(requiredCoverage(input.value, input.schema));
      checks.push('requiredFields');
    }
    if (mode === 'crossFieldConsistency') {
      scores.push(selfConsistency(input.value, input.samples ?? []));
      scores.push(opts.domain?.(input.docType, input.value) ?? crossFieldPlausibility(input.docType, input.value));
      checks.push(opts.domain ? 'crossField:domain' : 'crossField~structural');
    }
    const agreement = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.5;
    return { agreement, disagrees: agreement < 0.34, checksRun: checks };
  };
}

/** Fraction of declared fields whose value type matches the schema. */
function typeAgreement(value: Record<string, unknown>, schema: JsonSchema): number {
  const keys = Object.keys(schema.properties);
  if (keys.length === 0) return 0.5;
  let ok = 0;
  for (const k of keys) if (k in value && typeMatches(value[k], schema.properties[k].type)) ok++;
  return ok / keys.length;
}

/** Fraction of REQUIRED fields present + non-empty. */
function requiredCoverage(value: Record<string, unknown>, schema: JsonSchema): number {
  if (schema.required.length === 0) return 1;
  let ok = 0;
  for (const r of schema.required) {
    const v = value[r];
    if (v !== undefined && v !== null && v !== '') ok++;
  }
  return ok / schema.required.length;
}

/** Fraction of samples canonically matching the chosen extraction — the multi-solver agreement. */
function selfConsistency(value: Record<string, unknown>, samples: (Record<string, unknown> | null)[]): number {
  const target = canonicalJson(value);
  const all = [target, ...samples.map(canonicalJson).filter((s): s is string => s !== null)];
  if (all.length <= 1) return 0.5;
  return all.filter((s) => s === target).length / all.length;
}

/** Cheap cross-field sanity floor — not a truth check, a shape check (non-degenerate, plausibly consistent). */
function crossFieldPlausibility(docType: DocType, value: Record<string, unknown>): number {
  const keys = Object.keys(value);
  if (keys.length === 0) return 0;
  // invoices/receipts: a numeric total should be non-negative when present
  if (docType === 'invoice' || docType === 'receipt') {
    const total = value.total ?? value.amount ?? value.subtotal;
    if (typeof total === 'number' && total < 0) return 0.2;
  }
  return 0.5;
}
