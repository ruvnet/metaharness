import type { Policy } from '@metaharness/flywheel';
import { CEILINGS, DEFAULT_INDEPENDENCE_WEIGHTS } from 'radio-moe';

/** The only radio-moe parameters Autogenous currently authorizes evolution to change. */
export const AUTOGENOUS_MUTATION_TARGETS = [
  'sameProvider',
  'sameArch',
  'sameSize',
  'sourceJaccard',
  'quorumThreshold',
] as const;

export type AutogenousMutationTarget = (typeof AUTOGENOUS_MUTATION_TARGETS)[number];

/** Constitutional bounds: radio-moe's own mesh-evolve `CEILINGS`, imported rather than copied. */
export const AUTOGENOUS_CEILINGS = CEILINGS;

/** Frozen until Autogenous adds a dedicated accuracy-band benchmark (radio-moe default). */
export const FROZEN_SAME_ACCURACY_BAND: number = requireNumber(
  DEFAULT_INDEPENDENCE_WEIGHTS.sameAccuracyBand,
  'radio-moe DEFAULT_INDEPENDENCE_WEIGHTS.sameAccuracyBand',
);

function requireNumber(value: number | undefined, name: string): number {
  // Fail at import rather than evolve against a silently invented default.
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} is missing`);
  return value;
}

/** radio-moe `evolveMesh`'s default start quorum (radio-moe exports no constant for it). */
export const ROOT_QUORUM_THRESHOLD = 2;

const W_MIN = CEILINGS.weightMin;
const W_MAX = CEILINGS.weightMax;
const Q_MIN = CEILINGS.quorumMin;
const Q_MAX = CEILINGS.quorumMax;

export interface AutogenousMeshGenome {
  weights: {
    sameProvider: number;
    sameArch: number;
    sameSize: number;
    sourceJaccard: number;
    readonly sameAccuracyBand: number;
  };
  quorumThreshold: number;
}

/** Shipped radio-moe defaults (`DEFAULT_INDEPENDENCE_WEIGHTS`), before any project-local champion. */
export function rootGenome(): AutogenousMeshGenome {
  return {
    weights: {
      sameProvider: DEFAULT_INDEPENDENCE_WEIGHTS.sameProvider,
      sameArch: DEFAULT_INDEPENDENCE_WEIGHTS.sameArch,
      sameSize: DEFAULT_INDEPENDENCE_WEIGHTS.sameSize,
      sourceJaccard: DEFAULT_INDEPENDENCE_WEIGHTS.sourceJaccard,
      sameAccuracyBand: FROZEN_SAME_ACCURACY_BAND,
    },
    quorumThreshold: ROOT_QUORUM_THRESHOLD,
  };
}

/** The reference champion documented by autogenous/packages/radio-moe. */
export function referenceChampionGenome(): AutogenousMeshGenome {
  return {
    weights: {
      sameProvider: 0.6248072216752918,
      sameArch: 0.4386243325192481,
      sameSize: 0.1,
      sourceJaccard: 0.15,
      sameAccuracyBand: FROZEN_SAME_ACCURACY_BAND,
    },
    quorumThreshold: 1.8682114632800222,
  };
}

export function genomeToPolicy(genome: AutogenousMeshGenome): Policy {
  return {
    sameProvider: String(genome.weights.sameProvider),
    sameArch: String(genome.weights.sameArch),
    sameSize: String(genome.weights.sameSize),
    sourceJaccard: String(genome.weights.sourceJaccard),
    quorumThreshold: String(genome.quorumThreshold),
  };
}

export function policyToGenome(policy: Policy): AutogenousMeshGenome {
  const defaults = rootGenome();
  return {
    weights: {
      sameProvider: bounded(policy.sameProvider, defaults.weights.sameProvider, W_MIN, W_MAX),
      sameArch: bounded(policy.sameArch, defaults.weights.sameArch, W_MIN, W_MAX),
      sameSize: bounded(policy.sameSize, defaults.weights.sameSize, W_MIN, W_MAX),
      sourceJaccard: bounded(policy.sourceJaccard, defaults.weights.sourceJaccard, W_MIN, W_MAX),
      sameAccuracyBand: FROZEN_SAME_ACCURACY_BAND,
    },
    quorumThreshold: bounded(policy.quorumThreshold, defaults.quorumThreshold, Q_MIN, Q_MAX),
  };
}

/** Reject malformed/out-of-bounds policies instead of silently granting a larger search surface. */
export function policyViolations(policy: Policy): string[] {
  const allowed = new Set<string>(AUTOGENOUS_MUTATION_TARGETS);
  const violations: string[] = [];
  for (const key of Object.keys(policy)) {
    if (!allowed.has(key)) violations.push(`unknown_lever:${key}`);
  }
  for (const target of AUTOGENOUS_MUTATION_TARGETS) {
    const raw = policy[target];
    const value = Number(raw);
    if (raw === undefined || raw.trim() === '' || !Number.isFinite(value)) {
      violations.push(`invalid_number:${target}`);
      continue;
    }
    const [min, max] = target === 'quorumThreshold' ? [Q_MIN, Q_MAX] : [W_MIN, W_MAX];
    if (value < min || value > max) violations.push(`out_of_bounds:${target}`);
  }
  return violations;
}

export function clampLever(target: string, proposed: string, current: string): string {
  if (!(AUTOGENOUS_MUTATION_TARGETS as readonly string[]).includes(target)) return current;
  const fallback = Number(current);
  const parsed = Number(proposed);
  const value = Number.isFinite(parsed) ? parsed : Number.isFinite(fallback) ? fallback : 0;
  return String(target === 'quorumThreshold' ? clamp(value, Q_MIN, Q_MAX) : clamp(value, W_MIN, W_MAX));
}

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  return clamp(Number.isFinite(value) ? value : fallback, min, max);
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
