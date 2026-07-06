// @metaharness/evals-extract — the STRUCTURED-EXTRACTION POLICY GENOME.
//
// The genome is deliberately small, typed, and auditable. The flywheel evolves the HARNESS POLICY that
// decides how strictly to adhere to the schema, how to normalize fields, how to verify (json-schema-validate),
// route, abstain, and calibrate — NOT the model. Models, evaluator, and the private holdout are frozen; only
// this genome mutates. Arbitrary prose mutation is how you get benchmark superstition, so EVERY lever is a
// bounded enum or a clamped number — never free text.
//
// The flywheel's engine evolves a FLAT `Policy` (Record<string,string>), one lever per generation. So the
// typed genome round-trips through a flat string projection (`genomeToPolicy` / `policyToGenome`). The flat
// keys ARE the mutation classes.

/** How strictly an extracted JSON object must adhere to the schema. Chosen per doc type; drives the
 *  normalizer + verifier. `lenient` coerces/ignores extras; `strict` forbids additional properties. */
export const SCHEMA_STRICTNESS = ['lenient', 'coerce', 'strict', 'strictAdditional'] as const;
export type SchemaStrictness = (typeof SCHEMA_STRICTNESS)[number];

/** How a candidate extraction is verified. NOT a generic "critic says yes" (ADR-226: read-only advice = 0
 *  marginal resolves at 5.4x cost). Real, deterministic checks over the JSON; `none` is the cheap default. */
export const VERIFICATION_MODES = ['none', 'jsonSchemaValidate', 'typeCheck', 'requiredFields', 'crossFieldConsistency'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

/** How confidence is derived — feeds escalation + abstention. */
export const CONFIDENCE_RULES = ['selfReport', 'fieldCoverage', 'verifierAgreement', 'hybrid'] as const;
export type ConfidenceRule = (typeof CONFIDENCE_RULES)[number];

/** Bounded extractor-prompt STYLES (not free prose). This is the schema that keeps mutation boring. */
export const EXTRACTION_STYLES = ['direct-json', 'field-by-field', 'schema-first', 'validate-then-emit'] as const;
export type ExtractionStyle = (typeof EXTRACTION_STYLES)[number];

/** The document types extraction spans. The classifier maps a document to one of these; the verifier stack
 *  is chosen per doc type. Kept fixed + small on purpose (a mutable taxonomy is a leakage surface). */
export const DOC_TYPES = [
  'invoice', 'receipt', 'resume', 'contract', 'email', 'form', 'article', 'other',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface DocTypePolicy {
  extractionStyle: ExtractionStyle;
  schemaStrictness: SchemaStrictness;
  verificationMode: VerificationMode;
  /** Escalate to a stronger pass when confidence < this. [0,1]. */
  escalationThreshold: number;
  /** Max extraction candidates to sample for self-consistency. [1,8]. */
  maxCandidates: number;
  confidenceRule: ConfidenceRule;
  /** Abstain (emit no object) when final confidence < this. [0,1]. Abstention counts as a no-op. */
  abstainThreshold: number;
}

export interface GlobalPolicy {
  normalizeFields: boolean;
  requireAllRequiredFields: boolean;
  allowToolUse: boolean;
  maxCostPerDocUsd: number;
  maxLatencyMs: number;
}

export interface ExtractPolicyGenome {
  /** Per-doc-type overrides. A missing doc type falls back to `defaults`. */
  docTypePolicy: Partial<Record<DocType, DocTypePolicy>>;
  /** The default doc-type policy — what most levers actually tune (doc-type overrides layer on top). */
  defaults: DocTypePolicy;
  global: GlobalPolicy;
}

/** The mutation CLASSES — each is one flat lever the flywheel may evolve. Bias future proposals toward the
 *  classes that actually promote. */
export const MUTATION_CLASSES = [
  'extractionStyle',
  'schemaStrictness',
  'verificationMode',
  'escalationThreshold',
  'maxCandidates',
  'confidenceRule',
  'abstainThreshold',
  'normalizeFields',
  'requireAllRequiredFields',
  'maxCostPerDocUsd',
] as const;
export type MutationClass = (typeof MUTATION_CLASSES)[number];

export const DEFAULT_DOCTYPE_POLICY: DocTypePolicy = {
  extractionStyle: 'direct-json',
  schemaStrictness: 'coerce',
  verificationMode: 'none',
  escalationThreshold: 0.5,
  maxCandidates: 1,
  confidenceRule: 'selfReport',
  abstainThreshold: 0.15,
};

export const DEFAULT_GLOBAL_POLICY: GlobalPolicy = {
  normalizeFields: true,
  requireAllRequiredFields: true,
  allowToolUse: false,
  maxCostPerDocUsd: 0.05,
  maxLatencyMs: 60000,
};

/** The gen-0 root genome — the immutable baseline every promotion chains back to. */
export function rootGenome(): ExtractPolicyGenome {
  return { docTypePolicy: {}, defaults: { ...DEFAULT_DOCTYPE_POLICY }, global: { ...DEFAULT_GLOBAL_POLICY } };
}

/** Resolve the effective DocTypePolicy for a doc type (override on top of defaults). */
export function policyFor(genome: ExtractPolicyGenome, docType: DocType): DocTypePolicy {
  return { ...genome.defaults, ...(genome.docTypePolicy[docType] ?? {}) };
}

// ── flat <-> typed projection (the flywheel evolves the flat form) ────────────────────────────────────
// The flat levers tune the `defaults` block + the `global` block. Doc-type overrides are carried verbatim in
// a single JSON lever so the round-trip is lossless without exploding the mutation surface.

export function genomeToPolicy(g: ExtractPolicyGenome): Record<string, string> {
  return {
    extractionStyle: g.defaults.extractionStyle,
    schemaStrictness: g.defaults.schemaStrictness,
    verificationMode: g.defaults.verificationMode,
    escalationThreshold: String(g.defaults.escalationThreshold),
    maxCandidates: String(g.defaults.maxCandidates),
    confidenceRule: g.defaults.confidenceRule,
    abstainThreshold: String(g.defaults.abstainThreshold),
    normalizeFields: String(g.global.normalizeFields),
    requireAllRequiredFields: String(g.global.requireAllRequiredFields),
    maxCostPerDocUsd: String(g.global.maxCostPerDocUsd),
    // opaque carry-throughs (not mutated as classes)
    __docTypeOverrides: JSON.stringify(g.docTypePolicy),
    __allowToolUse: String(g.global.allowToolUse),
    __maxLatencyMs: String(g.global.maxLatencyMs),
  };
}

export function policyToGenome(p: Record<string, string>): ExtractPolicyGenome {
  const num = (v: string | undefined, d: number) => (v === undefined || Number.isNaN(Number(v)) ? d : Number(v));
  const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v === 'true');
  const oneOf = <T extends readonly string[]>(arr: T, v: string | undefined, d: T[number]): T[number] =>
    (arr as readonly string[]).includes(v ?? '') ? (v as T[number]) : d;
  let overrides: Partial<Record<DocType, DocTypePolicy>> = {};
  try { overrides = p.__docTypeOverrides ? JSON.parse(p.__docTypeOverrides) : {}; } catch { overrides = {}; }
  return {
    docTypePolicy: overrides,
    defaults: {
      extractionStyle: oneOf(EXTRACTION_STYLES, p.extractionStyle, DEFAULT_DOCTYPE_POLICY.extractionStyle),
      schemaStrictness: oneOf(SCHEMA_STRICTNESS, p.schemaStrictness, DEFAULT_DOCTYPE_POLICY.schemaStrictness),
      verificationMode: oneOf(VERIFICATION_MODES, p.verificationMode, DEFAULT_DOCTYPE_POLICY.verificationMode),
      escalationThreshold: clamp01(num(p.escalationThreshold, DEFAULT_DOCTYPE_POLICY.escalationThreshold)),
      maxCandidates: clampInt(num(p.maxCandidates, DEFAULT_DOCTYPE_POLICY.maxCandidates), 1, 8),
      confidenceRule: oneOf(CONFIDENCE_RULES, p.confidenceRule, DEFAULT_DOCTYPE_POLICY.confidenceRule),
      abstainThreshold: clamp01(num(p.abstainThreshold, DEFAULT_DOCTYPE_POLICY.abstainThreshold)),
    },
    global: {
      normalizeFields: bool(p.normalizeFields, DEFAULT_GLOBAL_POLICY.normalizeFields),
      requireAllRequiredFields: bool(p.requireAllRequiredFields, DEFAULT_GLOBAL_POLICY.requireAllRequiredFields),
      allowToolUse: bool(p.__allowToolUse, DEFAULT_GLOBAL_POLICY.allowToolUse),
      maxCostPerDocUsd: Math.max(0, num(p.maxCostPerDocUsd, DEFAULT_GLOBAL_POLICY.maxCostPerDocUsd)),
      maxLatencyMs: Math.max(0, num(p.__maxLatencyMs, DEFAULT_GLOBAL_POLICY.maxLatencyMs)),
    },
  };
}

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
export const clampInt = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(x)));
