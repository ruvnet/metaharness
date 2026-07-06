// @metaharness/evals-hle — the HLE POLICY GENOME.
//
// The genome is deliberately small, typed, and auditable. The flywheel evolves the HARNESS POLICY that
// decides how to answer/verify/route/abstain/calibrate — NOT the model. Models, evaluator, and the private
// holdout are frozen; only this genome mutates. Arbitrary prose mutation is how you get benchmark
// superstition, so EVERY lever is a bounded enum or a clamped number — never free text.
//
// The flywheel's engine evolves a FLAT `Policy` (Record<string,string>), one lever per generation. So the
// typed genome round-trips through a flat string projection (`genomeToPolicy` / `policyToGenome`). The flat
// keys ARE the mutation classes.

/** Answer shapes HLE questions take. Chosen per subject; drives the normalizer + verifier. */
export const ANSWER_FORMATS = ['short', 'equation', 'choice', 'numeric', 'proof'] as const;
export type AnswerFormat = (typeof ANSWER_FORMATS)[number];

/** How a candidate answer is verified. NOT a generic "critic says yes" (ADR-226: read-only advice = 0
 *  marginal resolves at 5.4x cost). Real, mostly-deterministic checks; `none` is the cheap default. */
export const VERIFICATION_MODES = ['none', 'symbolic', 'unitCheck', 'multiSolver', 'retrievalFreeCritic'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

/** How confidence is derived — feeds escalation + abstention. */
export const CONFIDENCE_RULES = ['logprob', 'selfConsistency', 'verifierAgreement', 'hybrid'] as const;
export type ConfidenceRule = (typeof CONFIDENCE_RULES)[number];

/** Bounded solver-prompt STYLES (not free prose). This is the schema that keeps mutation boring. */
export const SOLVER_STYLES = ['concise', 'stepwise', 'answer-first', 'verify-then-answer'] as const;
export type SolverStyle = (typeof SOLVER_STYLES)[number];

/** The subjects HLE spans. The classifier maps a question to one of these; the verifier stack is chosen
 *  per subject. Kept fixed + small on purpose (a mutable subject taxonomy is a leakage surface). */
export const SUBJECTS = [
  'math', 'physics', 'chemistry', 'biology', 'cs', 'law', 'history', 'other',
] as const;
export type Subject = (typeof SUBJECTS)[number];

export interface SubjectPolicy {
  solverStyle: SolverStyle;
  answerFormat: AnswerFormat;
  verificationMode: VerificationMode;
  /** Escalate to a stronger pass when confidence < this. [0,1]. */
  escalationThreshold: number;
  /** Max candidate answers to sample for self-consistency. [1,8]. */
  maxCandidates: number;
  confidenceRule: ConfidenceRule;
  /** Abstain (return no answer) when final confidence < this. [0,1]. Abstention counts as a no-op. */
  abstainThreshold: number;
}

export interface GlobalPolicy {
  normalizeFinalAnswer: boolean;
  requireAnswerOnly: boolean;
  allowToolUse: boolean;
  maxCostPerQuestionUsd: number;
  maxLatencyMs: number;
}

export interface HLEPolicyGenome {
  /** Per-subject overrides. A missing subject falls back to `defaults`. */
  subjectPolicy: Partial<Record<Subject, SubjectPolicy>>;
  /** The default subject policy — what most levers actually tune (subject overrides layer on top). */
  defaults: SubjectPolicy;
  global: GlobalPolicy;
}

/** The mutation CLASSES — each is one flat lever the flywheel may evolve. Bias future proposals toward the
 *  classes that actually promote (tracked in MutationStats, see `stats.ts`). */
export const MUTATION_CLASSES = [
  'solverStyle',
  'answerFormat',
  'verificationMode',
  'escalationThreshold',
  'maxCandidates',
  'confidenceRule',
  'abstainThreshold',
  'normalizeFinalAnswer',
  'requireAnswerOnly',
  'maxCostPerQuestionUsd',
] as const;
export type MutationClass = (typeof MUTATION_CLASSES)[number];

export const DEFAULT_SUBJECT_POLICY: SubjectPolicy = {
  solverStyle: 'concise',
  answerFormat: 'short',
  verificationMode: 'none',
  escalationThreshold: 0.5,
  maxCandidates: 1,
  confidenceRule: 'logprob',
  abstainThreshold: 0.15,
};

export const DEFAULT_GLOBAL_POLICY: GlobalPolicy = {
  normalizeFinalAnswer: true,
  requireAnswerOnly: true,
  allowToolUse: false,
  maxCostPerQuestionUsd: 0.05,
  maxLatencyMs: 60000,
};

/** The gen-0 root genome — the immutable baseline every promotion chains back to. */
export function rootGenome(): HLEPolicyGenome {
  return { subjectPolicy: {}, defaults: { ...DEFAULT_SUBJECT_POLICY }, global: { ...DEFAULT_GLOBAL_POLICY } };
}

/** Resolve the effective SubjectPolicy for a subject (subject override on top of defaults). */
export function policyFor(genome: HLEPolicyGenome, subject: Subject): SubjectPolicy {
  return { ...genome.defaults, ...(genome.subjectPolicy[subject] ?? {}) };
}

// ── flat <-> typed projection (the flywheel evolves the flat form) ────────────────────────────────────
// The flat levers tune the `defaults` block + the `global` block. Subject overrides are carried verbatim in
// a single JSON lever so the round-trip is lossless without exploding the mutation surface.

export function genomeToPolicy(g: HLEPolicyGenome): Record<string, string> {
  return {
    solverStyle: g.defaults.solverStyle,
    answerFormat: g.defaults.answerFormat,
    verificationMode: g.defaults.verificationMode,
    escalationThreshold: String(g.defaults.escalationThreshold),
    maxCandidates: String(g.defaults.maxCandidates),
    confidenceRule: g.defaults.confidenceRule,
    abstainThreshold: String(g.defaults.abstainThreshold),
    normalizeFinalAnswer: String(g.global.normalizeFinalAnswer),
    requireAnswerOnly: String(g.global.requireAnswerOnly),
    maxCostPerQuestionUsd: String(g.global.maxCostPerQuestionUsd),
    // opaque carry-throughs (not mutated as classes)
    __subjectOverrides: JSON.stringify(g.subjectPolicy),
    __allowToolUse: String(g.global.allowToolUse),
    __maxLatencyMs: String(g.global.maxLatencyMs),
  };
}

export function policyToGenome(p: Record<string, string>): HLEPolicyGenome {
  const num = (v: string | undefined, d: number) => (v === undefined || Number.isNaN(Number(v)) ? d : Number(v));
  const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v === 'true');
  const oneOf = <T extends readonly string[]>(arr: T, v: string | undefined, d: T[number]): T[number] =>
    (arr as readonly string[]).includes(v ?? '') ? (v as T[number]) : d;
  let overrides: Partial<Record<Subject, SubjectPolicy>> = {};
  try { overrides = p.__subjectOverrides ? JSON.parse(p.__subjectOverrides) : {}; } catch { overrides = {}; }
  return {
    subjectPolicy: overrides,
    defaults: {
      solverStyle: oneOf(SOLVER_STYLES, p.solverStyle, DEFAULT_SUBJECT_POLICY.solverStyle),
      answerFormat: oneOf(ANSWER_FORMATS, p.answerFormat, DEFAULT_SUBJECT_POLICY.answerFormat),
      verificationMode: oneOf(VERIFICATION_MODES, p.verificationMode, DEFAULT_SUBJECT_POLICY.verificationMode),
      escalationThreshold: clamp01(num(p.escalationThreshold, DEFAULT_SUBJECT_POLICY.escalationThreshold)),
      maxCandidates: clampInt(num(p.maxCandidates, DEFAULT_SUBJECT_POLICY.maxCandidates), 1, 8),
      confidenceRule: oneOf(CONFIDENCE_RULES, p.confidenceRule, DEFAULT_SUBJECT_POLICY.confidenceRule),
      abstainThreshold: clamp01(num(p.abstainThreshold, DEFAULT_SUBJECT_POLICY.abstainThreshold)),
    },
    global: {
      normalizeFinalAnswer: bool(p.normalizeFinalAnswer, DEFAULT_GLOBAL_POLICY.normalizeFinalAnswer),
      requireAnswerOnly: bool(p.requireAnswerOnly, DEFAULT_GLOBAL_POLICY.requireAnswerOnly),
      allowToolUse: bool(p.__allowToolUse, DEFAULT_GLOBAL_POLICY.allowToolUse),
      maxCostPerQuestionUsd: Math.max(0, num(p.maxCostPerQuestionUsd, DEFAULT_GLOBAL_POLICY.maxCostPerQuestionUsd)),
      maxLatencyMs: Math.max(0, num(p.__maxLatencyMs, DEFAULT_GLOBAL_POLICY.maxLatencyMs)),
    },
  };
}

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
export const clampInt = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(x)));
