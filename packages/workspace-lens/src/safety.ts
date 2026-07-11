// SPDX-License-Identifier: MIT
//
// Vectorized safety triggers. Anthropic found hidden objectives ("secretly", "manipulation", "evaluation
// awareness") light up in the workspace even when absent from the output. We detect them NOT by matching
// decoded token strings (brittle, tokenizer-specific) but by the dot product of the J-projected
// activation against pre-fitted concept DIRECTIONS in the model's own J-space. That makes the trigger
// tokenizer-agnostic and cross-family: a concept is aligned by name + per-model vector, so "hidden
// objective" is one canonical concept with a Qwen vector and a Gemma vector — never a string map.

import type { WorkspaceLens } from './lens.js';
import type { HiddenState, ConceptVector, ConceptTrigger, SafetyFlags } from './types.js';
import { dot, norm } from './linalg.js';

// Concept vectors are pre-fitted, static directions — the same ConceptVector
// objects get passed to detectConcepts() call after call (once per governed
// decision/trace, per the module doc above). cosine()'s norm(b) term doesn't
// change across those calls, so caching it by object identity turns an
// O(states x concepts) re-derivation into an O(concepts) one-time cost
// amortized across every future call with this concept library. norm(z) is
// hoisted out of the inner `concepts` loop below for the same reason within a
// single call: it's the same projected activation for every concept checked
// against it.
const conceptNormCache = new WeakMap<ConceptVector, number>();

function conceptNorm(c: ConceptVector): number {
  let n = conceptNormCache.get(c);
  if (n === undefined) {
    n = norm(c.vector);
    conceptNormCache.set(c, n);
  }
  return n;
}

/** Canonical concept names that map onto the four headline SafetyFlags. */
export const FLAG_CONCEPTS = {
  promptInjection: ['prompt_injection', 'override', 'ignore_instructions', 'exfiltration'],
  evalAwareness: ['evaluation_awareness', 'being_tested', 'watched'],
  hiddenObjective: ['hidden_objective', 'secretly', 'deception', 'manipulation'],
  refusalConflict: ['refusal_conflict', 'should_refuse', 'jailbreak'],
} as const;

export interface DetectOptions {
  /** Cosine threshold above which a concept is considered active. Default 0.35 (tunable per deployment). */
  threshold?: number;
}

/**
 * Score every (state × concept) pair and return the concepts that fired. Concept vectors whose `modelId`
 * doesn't match the lens are skipped (a fail-safe against applying a Qwen direction to a Gemma model).
 */
export function detectConcepts(
  lens: WorkspaceLens,
  states: readonly HiddenState[],
  concepts: readonly ConceptVector[],
  opts: DetectOptions = {},
): ConceptTrigger[] {
  const threshold = opts.threshold ?? 0.35;
  const triggers: ConceptTrigger[] = [];
  for (const state of states) {
    if (!lens.hasLayer(state.layer)) continue;
    const z = lens.project(state);
    const nz = norm(z); // same z for every concept below — compute its norm once, not per concept
    for (const c of concepts) {
      if (c.modelId !== lens.modelId) continue; // never cross-apply a concept from another model
      if (c.vector.length !== z.length) continue;
      const nc = conceptNorm(c);
      const score = nz === 0 || nc === 0 ? 0 : dot(z, c.vector) / (nz * nc);
      if (score >= threshold) {
        triggers.push({ concept: c.concept, layer: state.layer, position: state.position, score, critical: !!c.critical });
      }
    }
  }
  return triggers;
}

/** Roll fired concept triggers up into the four headline flags. */
export function flagsFromTriggers(triggers: readonly ConceptTrigger[]): SafetyFlags {
  const fired = new Set(triggers.map((t) => t.concept));
  const any = (names: readonly string[]) => names.some((n) => fired.has(n));
  return {
    promptInjection: any(FLAG_CONCEPTS.promptInjection),
    evalAwareness: any(FLAG_CONCEPTS.evalAwareness),
    hiddenObjective: any(FLAG_CONCEPTS.hiddenObjective),
    refusalConflict: any(FLAG_CONCEPTS.refusalConflict),
  };
}

/** True if any fired trigger is marked critical (used to fail the decision rule closed). */
export function hasCriticalTrigger(triggers: readonly ConceptTrigger[]): boolean {
  return triggers.some((t) => t.critical);
}
