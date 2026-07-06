// @metaharness/evals-toolcall — the TOOL-CALL POLICY GENOME.
//
// The genome is deliberately small, typed, and auditable. The flywheel evolves the HARNESS POLICY that
// decides how to select a tool, format its arguments, verify the produced call against the schema, retry on a
// malformed call, escalate, abstain, and calibrate — NOT the model. Models, evaluator, and the private
// holdout are frozen; only this genome mutates. Arbitrary prose mutation is how you get benchmark
// superstition, so EVERY lever is a bounded enum or a clamped number — never free text.
//
// The flywheel's engine evolves a FLAT `Policy` (Record<string,string>), one lever per generation. So the
// typed genome round-trips through a flat string projection (`genomeToPolicy` / `policyToGenome`). The flat
// keys ARE the mutation classes.

/** How the model decides WHICH tool to call. Chosen per category; drives the prompt shape (not the schema). */
export const SELECTION_STYLES = ['direct', 'think-then-call', 'enumerate-then-select', 'schema-first'] as const;
export type SelectionStyle = (typeof SELECTION_STYLES)[number];

/** How arguments are canonicalized before matching. NOT free prose — a bounded strictness ladder from a raw
 *  string compare up to full type coercion. Drives the normalizer + `callMatch`. */
export const ARG_FORMATS = ['loose', 'json', 'typed', 'coerced'] as const;
export type ArgFormat = (typeof ARG_FORMATS)[number];

/** How a produced call is verified against the tool schema. NOT a generic "critic says yes" (ADR-226:
 *  read-only advice = 0 marginal resolves at 5.4x cost). Real, mostly-deterministic checks over the call +
 *  its declared schema; `none` is the cheap default. */
export const VERIFICATION_MODES = ['none', 'schemaCheck', 'typeCheck', 'enumCheck', 'multiSample'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

/** How confidence is derived — feeds escalation + abstention. */
export const CONFIDENCE_RULES = ['logprob', 'selfConsistency', 'verifierAgreement', 'hybrid'] as const;
export type ConfidenceRule = (typeof CONFIDENCE_RULES)[number];

/** The BFCL-style CALL CATEGORIES a query falls into. The classifier maps a query to one of these; the
 *  verifier stack + selection style are chosen per category. Kept fixed + small on purpose (a mutable
 *  category taxonomy is a leakage surface). */
export const CATEGORIES = [
  'simple', 'multiple', 'parallel', 'parallelMultiple', 'irrelevance', 'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface CategoryPolicy {
  selectionStyle: SelectionStyle;
  argFormat: ArgFormat;
  verificationMode: VerificationMode;
  /** Escalate to a stronger pass when confidence < this. [0,1]. */
  escalationThreshold: number;
  /** Max candidate calls to sample for self-consistency. [1,8]. */
  maxCandidates: number;
  confidenceRule: ConfidenceRule;
  /** Abstain (emit no call) when final confidence < this. [0,1]. Abstention counts as a no-op. */
  abstainThreshold: number;
  /** Retry the SAME tier on a malformed call before escalating. [0,4]. */
  maxRetries: number;
}

export interface GlobalPolicy {
  normalizeArgs: boolean;
  strictSchema: boolean;
  allowParallelCalls: boolean;
  maxCostPerCallUsd: number;
  maxLatencyMs: number;
}

export interface ToolcallPolicyGenome {
  /** Per-category overrides. A missing category falls back to `defaults`. */
  categoryPolicy: Partial<Record<Category, CategoryPolicy>>;
  /** The default category policy — what most levers actually tune (category overrides layer on top). */
  defaults: CategoryPolicy;
  global: GlobalPolicy;
}

/** The mutation CLASSES — each is one flat lever the flywheel may evolve. Bias future proposals toward the
 *  classes that actually promote (tracked in MutationStats). */
export const MUTATION_CLASSES = [
  'selectionStyle',
  'argFormat',
  'verificationMode',
  'escalationThreshold',
  'maxCandidates',
  'confidenceRule',
  'abstainThreshold',
  'maxRetries',
  'normalizeArgs',
  'strictSchema',
  'maxCostPerCallUsd',
] as const;
export type MutationClass = (typeof MUTATION_CLASSES)[number];

export const DEFAULT_CATEGORY_POLICY: CategoryPolicy = {
  selectionStyle: 'direct',
  argFormat: 'loose',
  verificationMode: 'none',
  escalationThreshold: 0.5,
  maxCandidates: 1,
  confidenceRule: 'logprob',
  abstainThreshold: 0.15,
  maxRetries: 0,
};

export const DEFAULT_GLOBAL_POLICY: GlobalPolicy = {
  normalizeArgs: true,
  strictSchema: true,
  allowParallelCalls: false,
  maxCostPerCallUsd: 0.05,
  maxLatencyMs: 60000,
};

/** The gen-0 root genome — the immutable baseline every promotion chains back to. */
export function rootGenome(): ToolcallPolicyGenome {
  return { categoryPolicy: {}, defaults: { ...DEFAULT_CATEGORY_POLICY }, global: { ...DEFAULT_GLOBAL_POLICY } };
}

/** Resolve the effective CategoryPolicy for a category (category override on top of defaults). */
export function policyFor(genome: ToolcallPolicyGenome, category: Category): CategoryPolicy {
  return { ...genome.defaults, ...(genome.categoryPolicy[category] ?? {}) };
}

// ── flat <-> typed projection (the flywheel evolves the flat form) ────────────────────────────────────
// The flat levers tune the `defaults` block + the `global` block. Category overrides are carried verbatim in
// a single JSON lever so the round-trip is lossless without exploding the mutation surface.

export function genomeToPolicy(g: ToolcallPolicyGenome): Record<string, string> {
  return {
    selectionStyle: g.defaults.selectionStyle,
    argFormat: g.defaults.argFormat,
    verificationMode: g.defaults.verificationMode,
    escalationThreshold: String(g.defaults.escalationThreshold),
    maxCandidates: String(g.defaults.maxCandidates),
    confidenceRule: g.defaults.confidenceRule,
    abstainThreshold: String(g.defaults.abstainThreshold),
    maxRetries: String(g.defaults.maxRetries),
    normalizeArgs: String(g.global.normalizeArgs),
    strictSchema: String(g.global.strictSchema),
    maxCostPerCallUsd: String(g.global.maxCostPerCallUsd),
    // opaque carry-throughs (not mutated as classes)
    __categoryOverrides: JSON.stringify(g.categoryPolicy),
    __allowParallelCalls: String(g.global.allowParallelCalls),
    __maxLatencyMs: String(g.global.maxLatencyMs),
  };
}

export function policyToGenome(p: Record<string, string>): ToolcallPolicyGenome {
  const num = (v: string | undefined, d: number) => (v === undefined || Number.isNaN(Number(v)) ? d : Number(v));
  const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v === 'true');
  const oneOf = <T extends readonly string[]>(arr: T, v: string | undefined, d: T[number]): T[number] =>
    (arr as readonly string[]).includes(v ?? '') ? (v as T[number]) : d;
  let overrides: Partial<Record<Category, CategoryPolicy>> = {};
  try { overrides = p.__categoryOverrides ? JSON.parse(p.__categoryOverrides) : {}; } catch { overrides = {}; }
  return {
    categoryPolicy: overrides,
    defaults: {
      selectionStyle: oneOf(SELECTION_STYLES, p.selectionStyle, DEFAULT_CATEGORY_POLICY.selectionStyle),
      argFormat: oneOf(ARG_FORMATS, p.argFormat, DEFAULT_CATEGORY_POLICY.argFormat),
      verificationMode: oneOf(VERIFICATION_MODES, p.verificationMode, DEFAULT_CATEGORY_POLICY.verificationMode),
      escalationThreshold: clamp01(num(p.escalationThreshold, DEFAULT_CATEGORY_POLICY.escalationThreshold)),
      maxCandidates: clampInt(num(p.maxCandidates, DEFAULT_CATEGORY_POLICY.maxCandidates), 1, 8),
      confidenceRule: oneOf(CONFIDENCE_RULES, p.confidenceRule, DEFAULT_CATEGORY_POLICY.confidenceRule),
      abstainThreshold: clamp01(num(p.abstainThreshold, DEFAULT_CATEGORY_POLICY.abstainThreshold)),
      maxRetries: clampInt(num(p.maxRetries, DEFAULT_CATEGORY_POLICY.maxRetries), 0, 4),
    },
    global: {
      normalizeArgs: bool(p.normalizeArgs, DEFAULT_GLOBAL_POLICY.normalizeArgs),
      strictSchema: bool(p.strictSchema, DEFAULT_GLOBAL_POLICY.strictSchema),
      allowParallelCalls: bool(p.__allowParallelCalls, DEFAULT_GLOBAL_POLICY.allowParallelCalls),
      maxCostPerCallUsd: Math.max(0, num(p.maxCostPerCallUsd, DEFAULT_GLOBAL_POLICY.maxCostPerCallUsd)),
      maxLatencyMs: Math.max(0, num(p.__maxLatencyMs, DEFAULT_GLOBAL_POLICY.maxLatencyMs)),
    },
  };
}

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
export const clampInt = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(x)));
