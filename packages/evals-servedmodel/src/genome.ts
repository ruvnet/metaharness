// @metaharness/evals-servedmodel — the SERVED-MODEL POLICY GENOME (ADR-234).
//
// ruvllm's live SONA/MicroLoRA micro-loop adapts real weights per request; the flywheel macro-loop never
// touches those weights directly. Instead it evolves this small, typed, auditable GENOME — the *serving
// policy* that governs HOW the micro-loop is allowed to adapt (rank, forgetting-guard strength, routing
// depth, aggressiveness). Every lever is a bounded enum or a clamped number, never free text — the same
// anti-superstition discipline as `@metaharness/evals-hle`'s `HLEPolicyGenome`. The flywheel evolves a FLAT
// `Policy` (Record<string,string>); this genome round-trips through `genomeToPolicy` / `policyToGenome`.
/** MicroLoRA rank — ADR-234 verified ranks 1-4 in the live `ruvllm_microlora_create` surface. */
export const clampRank = (x: number): number => clampInt(x, 1, 4);

/** How aggressively the micro-loop is allowed to move weights per request. Ordinal — 'off' never adapts. */
export const ADAPTATION_MODES = ['off', 'conservative', 'balanced', 'aggressive'] as const;
export type AdaptationMode = (typeof ADAPTATION_MODES)[number];

/** ruvector memory routing strategy feeding the micro-loop's context. */
export const MEMORY_ROUTING_MODES = ['none', 'nearest', 'hnsw', 'hybrid'] as const;
export type MemoryRoutingMode = (typeof MEMORY_ROUTING_MODES)[number];

/** When a live SONA/MicroLoRA state becomes ELIGIBLE for distillation into a flywheel candidate. */
export const DISTILLATION_TRIGGERS = ['manual', 'sampleCount', 'qualityPlateau'] as const;
export type DistillationTrigger = (typeof DISTILLATION_TRIGGERS)[number];

export interface ServedModelPolicyGenome {
  /** MicroLoRA rank. [1,4] — verified live range (ADR-234 §1.1). */
  microloraRank: number;
  /** EWC++ forgetting-guard weight. [0,1]. Verified live default 0.1 (ADR-234 §1.1). Higher = more
   *  resistant to drift, at the cost of slower adaptation (stability/plasticity tradeoff, ADR-234 §5). */
  ewcLambda: number;
  /** SONA EMA decay for the running quality signal. [0,1]. Verified live default 0.95. */
  emaDecay: number;
  /** SONA quality gate — an adaptation only commits when confidence clears this. [0,1]. Verified default 0.5. */
  qualityThreshold: number;
  /** ruvector HNSW memory-routing depth (candidates considered before adapting). [1,8]. */
  routingDepth: number;
  adaptationMode: AdaptationMode;
  memoryRoutingMode: MemoryRoutingMode;
  distillationTrigger: DistillationTrigger;
  /** Minimum samples_seen before a promoted MicroLoRA/SONA state is even eligible for distillation. >=1. */
  minSamplesForDistillation: number;
}

/** The mutation CLASSES — each is one flat lever the flywheel may evolve. */
export const MUTATION_CLASSES = [
  'microloraRank',
  'ewcLambda',
  'emaDecay',
  'qualityThreshold',
  'routingDepth',
  'adaptationMode',
  'memoryRoutingMode',
  'distillationTrigger',
  'minSamplesForDistillation',
] as const;
export type MutationClass = (typeof MUTATION_CLASSES)[number];

/** The gen-0 root genome — pinned to the values ADR-234 §1.1 actually VERIFIED by execution (not guessed). */
export const DEFAULT_GENOME: ServedModelPolicyGenome = {
  microloraRank: 2,
  ewcLambda: 0.1,
  emaDecay: 0.95,
  qualityThreshold: 0.5,
  routingDepth: 2,
  adaptationMode: 'conservative',
  memoryRoutingMode: 'hnsw',
  distillationTrigger: 'sampleCount',
  minSamplesForDistillation: 50,
};

export function rootGenome(): ServedModelPolicyGenome {
  return { ...DEFAULT_GENOME };
}

// ── flat <-> typed projection (the flywheel evolves the flat form) ────────────────────────────────────

export function genomeToPolicy(g: ServedModelPolicyGenome): Record<string, string> {
  return {
    microloraRank: String(g.microloraRank),
    ewcLambda: String(g.ewcLambda),
    emaDecay: String(g.emaDecay),
    qualityThreshold: String(g.qualityThreshold),
    routingDepth: String(g.routingDepth),
    adaptationMode: g.adaptationMode,
    memoryRoutingMode: g.memoryRoutingMode,
    distillationTrigger: g.distillationTrigger,
    minSamplesForDistillation: String(g.minSamplesForDistillation),
  };
}

export function policyToGenome(p: Record<string, string>): ServedModelPolicyGenome {
  const num = (v: string | undefined, d: number) => (v === undefined || Number.isNaN(Number(v)) ? d : Number(v));
  const oneOf = <T extends readonly string[]>(arr: T, v: string | undefined, d: T[number]): T[number] =>
    (arr as readonly string[]).includes(v ?? '') ? (v as T[number]) : d;
  return {
    microloraRank: clampRank(num(p.microloraRank, DEFAULT_GENOME.microloraRank)),
    ewcLambda: clamp01(num(p.ewcLambda, DEFAULT_GENOME.ewcLambda)),
    emaDecay: clamp01(num(p.emaDecay, DEFAULT_GENOME.emaDecay)),
    qualityThreshold: clamp01(num(p.qualityThreshold, DEFAULT_GENOME.qualityThreshold)),
    routingDepth: clampInt(num(p.routingDepth, DEFAULT_GENOME.routingDepth), 1, 8),
    adaptationMode: oneOf(ADAPTATION_MODES, p.adaptationMode, DEFAULT_GENOME.adaptationMode),
    memoryRoutingMode: oneOf(MEMORY_ROUTING_MODES, p.memoryRoutingMode, DEFAULT_GENOME.memoryRoutingMode),
    distillationTrigger: oneOf(DISTILLATION_TRIGGERS, p.distillationTrigger, DEFAULT_GENOME.distillationTrigger),
    minSamplesForDistillation: Math.max(1, Math.round(num(p.minSamplesForDistillation, DEFAULT_GENOME.minSamplesForDistillation))),
  };
}

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
export const clampInt = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(x)));

/** Ordinal index of an AdaptationMode — used by the evaluator/proposer to reason about aggressiveness. */
export function adaptationAggressiveness(mode: AdaptationMode): number {
  return ADAPTATION_MODES.indexOf(mode);
}
