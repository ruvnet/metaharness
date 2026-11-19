import type { Policy } from '@metaharness/flywheel';
import {
  admitMutation,
  scopePolicy,
  type AdmissionResult,
  type Genome,
  type Mutation,
  type MutationScope,
} from 'autogenous';
import { AUTOGENOUS_MUTATION_TARGETS } from './genome.js';

/**
 * AGL admission for a radio-moe policy candidate. The decision is made by the
 * Autogenous Rust `agl-types` crate (via the `autogenous` npm package's
 * WebAssembly build), not by this adapter.
 *
 * Independence weights and the quorum threshold decide how support is routed
 * and counted, so a candidate is an AGL `routing_budget` mutation: auto-
 * promotable, requesting exactly the scope's minimum authority, with the
 * parent genome as its rollback target.
 */
export const AUTOGENOUS_MUTATION_SCOPE: MutationScope = 'routing_budget';

/** Invariants the radio-moe policy surface must keep (ADR-396 / ADR-277). */
export const RADIO_MOE_INVARIANTS = ['policy_surface_bounded', 'same_accuracy_band_frozen'] as const;

/**
 * The default parent genome for a radio-moe candidate. Its `hash` and `constitution` are
 * adapter-local labels, not content hashes: with this default, AGL's verdict depends only on
 * the adapter's own invariant flags and the benchmark's `reversible`. Hosts that hold a real
 * Autogenous genome (with its constitution hash and capability ceiling) should pass it as
 * `parent`, and then AGL decides authority independently.
 */
export function radioMoeParentGenome(hash = 'radio-moe/mesh-evolve@root'): Genome {
  return {
    hash,
    identity: 'radio-moe/mesh-evolve',
    constitution: 'autogenous/adr-396',
    capability_ceiling: 'auto_reversible',
    hard_invariants: RADIO_MOE_INVARIANTS.map((name) => ({ name, holds: true })),
    lineage: [],
  };
}

/**
 * Express a flywheel policy as a typed AGL mutation of `parent`. `reversible` is the benchmark's
 * claim that the parent is still a verified rollback target; without it the mutation carries no
 * rollback target and AGL refuses it (`no_rollback`).
 */
export function policyMutation(
  policy: Policy,
  violations: readonly string[],
  parent: Genome,
  reversible = true,
): Mutation {
  const levers = AUTOGENOUS_MUTATION_TARGETS.map((t) => `${t}=${policy[t] ?? ''}`).join(',');
  return {
    id: `radio-moe-policy:${levers}`,
    parent_genome_hash: parent.hash,
    scope: AUTOGENOUS_MUTATION_SCOPE,
    requested_authority: scopePolicy(AUTOGENOUS_MUTATION_SCOPE).minAuthority,
    applicability: { workloads: ['radio-moe'], environments: [], jurisdictions: [] },
    preserved_invariants: [
      { name: 'policy_surface_bounded', holds: violations.length === 0 },
      { name: 'same_accuracy_band_frozen', holds: !Object.hasOwn(policy, 'sameAccuracyBand') },
    ],
    rollback_target: reversible ? parent.hash : null,
    expires_at: null,
    signature: null,
  };
}

export interface AutogenousAdmissionOptions {
  /** Whether the parent remains a verified rollback target. Default true. */
  reversible?: boolean;
  /** Parent genome. Default: `radioMoeParentGenome()`. */
  parent?: Genome;
  /** Unix seconds. Default: the current time. Only expiring mutations depend on it. */
  now?: () => number;
}

/** Run AGL admission for `policy`. A scope that may not auto-promote is never admitted. */
export function admitAutogenousPolicy(
  policy: Policy,
  violations: readonly string[],
  options: AutogenousAdmissionOptions = {},
): AdmissionResult {
  const parent = options.parent ?? radioMoeParentGenome();
  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  if (!scopePolicy(AUTOGENOUS_MUTATION_SCOPE).autoPromotable) {
    return { admissible: false, error: 'ConstitutionalScope', reason: 'constitutional_scope' };
  }
  return admitMutation(policyMutation(policy, violations, parent, options.reversible ?? true), parent, now);
}
