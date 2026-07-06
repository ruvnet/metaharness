// @metaharness/evals-sql — the TEXT-TO-SQL POLICY GENOME.
//
// The genome is deliberately small, typed, and auditable. The flywheel evolves the HARNESS POLICY that
// decides how to link-the-schema/decode/verify/route/abstain/calibrate — NOT the model. Models, executor,
// and the private holdout are frozen; only this genome mutates. Arbitrary prose mutation is how you get
// benchmark superstition, so EVERY lever is a bounded enum or a clamped number — never free text.
//
// The flywheel's engine evolves a FLAT `Policy` (Record<string,string>), one lever per generation. So the
// typed genome round-trips through a flat string projection (`genomeToPolicy` / `policyToGenome`). The flat
// keys ARE the mutation classes.

/** How schema elements (tables/columns) are linked to the question — drives the solver prompt + dry-run. */
export const SCHEMA_LINKING_STYLES = ['none', 'exactMatch', 'fuzzyMatch', 'embedding'] as const;
export type SchemaLinkingStyle = (typeof SCHEMA_LINKING_STYLES)[number];

/** Target SQL dialect. Chosen per query-type; drives the normalizer (quoting, LIMIT/TOP) + verifier. */
export const SQL_DIALECTS = ['sqlite', 'postgres', 'mysql', 'ansi'] as const;
export type SqlDialect = (typeof SQL_DIALECTS)[number];

/** How a candidate query is verified. `executeCompare` (run the SQL, compare result sets) is the strong,
 *  mostly-deterministic lever; `none` is the cheap default. NOT a generic "critic says yes" (ADR-226:
 *  read-only advice = 0 marginal resolves at 5.4x cost). */
export const VERIFICATION_MODES = ['none', 'parse', 'dryRun', 'executeCompare', 'selfConsistency'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

/** How confidence is derived — feeds escalation + abstention. */
export const CONFIDENCE_RULES = ['logprob', 'selfConsistency', 'executionAgreement', 'hybrid'] as const;
export type ConfidenceRule = (typeof CONFIDENCE_RULES)[number];

/** Bounded SQL-decoding STYLES (not free prose). This is the schema that keeps mutation boring. */
export const DECODING_STYLES = ['direct', 'chainOfThought', 'schemaFirst', 'skeletonThenFill'] as const;
export type DecodingStyle = (typeof DECODING_STYLES)[number];

/** The query TYPES a text-to-SQL suite spans. The classifier maps a question to one of these; the verifier
 *  stack + dialect are chosen per type. Kept fixed + small on purpose (a mutable taxonomy is a leakage
 *  surface). */
export const QUERY_TYPES = [
  'select', 'aggregate', 'join', 'nested', 'groupby', 'orderby', 'setops', 'other',
] as const;
export type QueryType = (typeof QUERY_TYPES)[number];

export interface QueryTypePolicy {
  decodingStyle: DecodingStyle;
  sqlDialect: SqlDialect;
  schemaLinking: SchemaLinkingStyle;
  verificationMode: VerificationMode;
  /** Escalate to a stronger pass when confidence < this. [0,1]. */
  escalationThreshold: number;
  /** Max candidate queries to sample for self-consistency. [1,8]. */
  maxCandidates: number;
  confidenceRule: ConfidenceRule;
  /** Abstain (return no query) when final confidence < this. [0,1]. Abstention counts as a no-op. */
  abstainThreshold: number;
}

export interface GlobalPolicy {
  normalizeSql: boolean;
  requireSingleStatement: boolean;
  allowExecution: boolean;
  maxCostPerQueryUsd: number;
  maxLatencyMs: number;
}

export interface SqlPolicyGenome {
  /** Per-query-type overrides. A missing type falls back to `defaults`. */
  typePolicy: Partial<Record<QueryType, QueryTypePolicy>>;
  /** The default query-type policy — what most levers actually tune (type overrides layer on top). */
  defaults: QueryTypePolicy;
  global: GlobalPolicy;
}

/** The mutation CLASSES — each is one flat lever the flywheel may evolve. Bias future proposals toward the
 *  classes that actually promote (tracked in MutationStats). */
export const MUTATION_CLASSES = [
  'decodingStyle',
  'sqlDialect',
  'schemaLinking',
  'verificationMode',
  'escalationThreshold',
  'maxCandidates',
  'confidenceRule',
  'abstainThreshold',
  'normalizeSql',
  'requireSingleStatement',
  'maxCostPerQueryUsd',
] as const;
export type MutationClass = (typeof MUTATION_CLASSES)[number];

export const DEFAULT_TYPE_POLICY: QueryTypePolicy = {
  decodingStyle: 'direct',
  sqlDialect: 'sqlite',
  schemaLinking: 'exactMatch',
  verificationMode: 'none',
  escalationThreshold: 0.5,
  maxCandidates: 1,
  confidenceRule: 'logprob',
  abstainThreshold: 0.15,
};

export const DEFAULT_GLOBAL_POLICY: GlobalPolicy = {
  normalizeSql: true,
  requireSingleStatement: true,
  allowExecution: false,
  maxCostPerQueryUsd: 0.05,
  maxLatencyMs: 60000,
};

/** The gen-0 root genome — the immutable baseline every promotion chains back to. */
export function rootGenome(): SqlPolicyGenome {
  return { typePolicy: {}, defaults: { ...DEFAULT_TYPE_POLICY }, global: { ...DEFAULT_GLOBAL_POLICY } };
}

/** Resolve the effective QueryTypePolicy for a query type (type override on top of defaults). */
export function policyFor(genome: SqlPolicyGenome, queryType: QueryType): QueryTypePolicy {
  return { ...genome.defaults, ...(genome.typePolicy[queryType] ?? {}) };
}

// ── flat <-> typed projection (the flywheel evolves the flat form) ────────────────────────────────────
// The flat levers tune the `defaults` block + the `global` block. Type overrides are carried verbatim in a
// single JSON lever so the round-trip is lossless without exploding the mutation surface.

export function genomeToPolicy(g: SqlPolicyGenome): Record<string, string> {
  return {
    decodingStyle: g.defaults.decodingStyle,
    sqlDialect: g.defaults.sqlDialect,
    schemaLinking: g.defaults.schemaLinking,
    verificationMode: g.defaults.verificationMode,
    escalationThreshold: String(g.defaults.escalationThreshold),
    maxCandidates: String(g.defaults.maxCandidates),
    confidenceRule: g.defaults.confidenceRule,
    abstainThreshold: String(g.defaults.abstainThreshold),
    normalizeSql: String(g.global.normalizeSql),
    requireSingleStatement: String(g.global.requireSingleStatement),
    maxCostPerQueryUsd: String(g.global.maxCostPerQueryUsd),
    // opaque carry-throughs (not mutated as classes)
    __typeOverrides: JSON.stringify(g.typePolicy),
    __allowExecution: String(g.global.allowExecution),
    __maxLatencyMs: String(g.global.maxLatencyMs),
  };
}

export function policyToGenome(p: Record<string, string>): SqlPolicyGenome {
  const num = (v: string | undefined, d: number) => (v === undefined || Number.isNaN(Number(v)) ? d : Number(v));
  const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v === 'true');
  const oneOf = <T extends readonly string[]>(arr: T, v: string | undefined, d: T[number]): T[number] =>
    (arr as readonly string[]).includes(v ?? '') ? (v as T[number]) : d;
  let overrides: Partial<Record<QueryType, QueryTypePolicy>> = {};
  try { overrides = p.__typeOverrides ? JSON.parse(p.__typeOverrides) : {}; } catch { overrides = {}; }
  return {
    typePolicy: overrides,
    defaults: {
      decodingStyle: oneOf(DECODING_STYLES, p.decodingStyle, DEFAULT_TYPE_POLICY.decodingStyle),
      sqlDialect: oneOf(SQL_DIALECTS, p.sqlDialect, DEFAULT_TYPE_POLICY.sqlDialect),
      schemaLinking: oneOf(SCHEMA_LINKING_STYLES, p.schemaLinking, DEFAULT_TYPE_POLICY.schemaLinking),
      verificationMode: oneOf(VERIFICATION_MODES, p.verificationMode, DEFAULT_TYPE_POLICY.verificationMode),
      escalationThreshold: clamp01(num(p.escalationThreshold, DEFAULT_TYPE_POLICY.escalationThreshold)),
      maxCandidates: clampInt(num(p.maxCandidates, DEFAULT_TYPE_POLICY.maxCandidates), 1, 8),
      confidenceRule: oneOf(CONFIDENCE_RULES, p.confidenceRule, DEFAULT_TYPE_POLICY.confidenceRule),
      abstainThreshold: clamp01(num(p.abstainThreshold, DEFAULT_TYPE_POLICY.abstainThreshold)),
    },
    global: {
      normalizeSql: bool(p.normalizeSql, DEFAULT_GLOBAL_POLICY.normalizeSql),
      requireSingleStatement: bool(p.requireSingleStatement, DEFAULT_GLOBAL_POLICY.requireSingleStatement),
      allowExecution: bool(p.__allowExecution, DEFAULT_GLOBAL_POLICY.allowExecution),
      maxCostPerQueryUsd: Math.max(0, num(p.maxCostPerQueryUsd, DEFAULT_GLOBAL_POLICY.maxCostPerQueryUsd)),
      maxLatencyMs: Math.max(0, num(p.__maxLatencyMs, DEFAULT_GLOBAL_POLICY.maxLatencyMs)),
    },
  };
}

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
export const clampInt = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(x)));
