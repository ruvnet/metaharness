import type { Policy } from '@metaharness/flywheel';

/** The only radio-moe parameters Autogenous currently authorizes evolution to change. */
export const AUTOGENOUS_MUTATION_TARGETS = [
  'sameProvider',
  'sameArch',
  'sameSize',
  'sourceJaccard',
  'quorumThreshold',
] as const;

export type AutogenousMutationTarget = (typeof AUTOGENOUS_MUTATION_TARGETS)[number];

/** Constitutional bounds copied from radio-moe's mesh-evolve.ts CEILINGS. */
export const AUTOGENOUS_CEILINGS = {
  weightMin: 0,
  weightMax: 0.8,
  quorumMin: 1.5,
  quorumMax: 4,
} as const;

/** Frozen until Autogenous adds a dedicated accuracy-band benchmark. */
export const FROZEN_SAME_ACCURACY_BAND = 0.2;

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

/** Shipped radio-moe defaults, before any project-local champion is applied. */
export function rootGenome(): AutogenousMeshGenome {
  return {
    weights: {
      sameProvider: 0.4,
      sameArch: 0.35,
      sameSize: 0.1,
      sourceJaccard: 0.15,
      sameAccuracyBand: FROZEN_SAME_ACCURACY_BAND,
    },
    quorumThreshold: 2,
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
      sameProvider: bounded(policy.sameProvider, defaults.weights.sameProvider, 0, 0.8),
      sameArch: bounded(policy.sameArch, defaults.weights.sameArch, 0, 0.8),
      sameSize: bounded(policy.sameSize, defaults.weights.sameSize, 0, 0.8),
      sourceJaccard: bounded(policy.sourceJaccard, defaults.weights.sourceJaccard, 0, 0.8),
      sameAccuracyBand: FROZEN_SAME_ACCURACY_BAND,
    },
    quorumThreshold: bounded(policy.quorumThreshold, defaults.quorumThreshold, 1.5, 4),
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
    const [min, max] = target === 'quorumThreshold' ? [1.5, 4] : [0, 0.8];
    if (value < min || value > max) violations.push(`out_of_bounds:${target}`);
  }
  return violations;
}

export function clampLever(target: string, proposed: string, current: string): string {
  if (!(AUTOGENOUS_MUTATION_TARGETS as readonly string[]).includes(target)) return current;
  const fallback = Number(current);
  const parsed = Number(proposed);
  const value = Number.isFinite(parsed) ? parsed : Number.isFinite(fallback) ? fallback : 0;
  return String(target === 'quorumThreshold' ? clamp(value, 1.5, 4) : clamp(value, 0, 0.8));
}

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  return clamp(Number.isFinite(value) ? value : fallback, min, max);
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
