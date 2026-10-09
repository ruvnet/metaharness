// One-parameter-at-a-time mutation for Darwin's numeric genome (ADR-272).
//
// Upstream `mutateGenome` (packages/darwin-mode/src/numeric-mutator.ts) adds
// Gaussian noise to EVERY parameter, so a child of a 16-param arena genome
// differs from its parent in ~all params and a score change cannot be pinned
// on any one knob. `evolveNumeric` imports `mutateGenome` directly (no config
// hook), so run-darwin.mjs redirects that one import to THIS module with a
// `module.registerHooks` resolve hook. Everything else evolveNumeric uses
// (crossover, defaultGenome, makeVariant, archive, selection) is the upstream
// code, re-exported unchanged.
//
// Step rule (a deterministic coordinate/lattice search, keyed only on the
// spec's scale/type, never on parameter names):
//   int + linear  -> +/- max(1, round(sigma * (max - min)))   (difficulty 1..3 -> +/-1)
//   log or float  -> +/- sigma in unit space ([min,max] or [ln min, ln max]),
//                    so log budgets move by a fixed factor (span 3072..16384,
//                    sigma 0.2 -> x/÷ ~1.40) and revisit the same values, which
//                    keeps the content-addressed cell cache hot.
// The parameter is chosen round-robin from a per-generation offset, so the
// children of one parent touch different parameters. If the step is a no-op
// (pinned param, or at a bound) the direction flips; if still a no-op the next
// parameter is tried. Exactly one parameter ever changes.

import {
  crossoverGenome,
  defaultGenome,
  makeVariant,
  mutateGenome as upstreamMutateGenome,
} from '../../../packages/darwin-mode/dist/numeric-mutator.js';

export { crossoverGenome, defaultGenome, makeVariant, upstreamMutateGenome };

let calls = 0;
/** How many times evolveNumeric has called this module's mutateGenome in this process. */
export function oneParamMutationCalls() { return calls; }

function hash(...parts) {
  let h = 0x811c9dc5;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// FNV-1a's low bit is just the parity of odd characters, so `hash(...) % 2`
// alternates with `index` in lockstep with the round-robin param choice
// (budget always went down, difficulty always up). Draw the direction from
// the same mulberry32 PRNG upstream uses instead.
function coin(seed) {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296 < 0.5;
}

const EPS = Number.EPSILON;
function toUnit(value, spec) {
  if (spec.scale === 'log') {
    const lo = Math.log(Math.max(spec.min, EPS));
    const hi = Math.log(Math.max(spec.max, EPS));
    return (Math.log(Math.max(value, EPS)) - lo) / Math.max(hi - lo, EPS);
  }
  return (value - spec.min) / Math.max(spec.max - spec.min, EPS);
}
function fromUnit(unit, spec) {
  const u = Math.min(1, Math.max(0, unit));
  let value;
  if (spec.scale === 'log') {
    const lo = Math.log(Math.max(spec.min, EPS));
    const hi = Math.log(Math.max(spec.max, EPS));
    value = Math.exp(lo + u * (hi - lo));
  } else {
    value = spec.min + u * (spec.max - spec.min);
  }
  value = Math.min(spec.max, Math.max(spec.min, value));
  return spec.type === 'int' ? Math.round(value) : value;
}

/** One step of `name` in direction `dir` (+1/-1). Returns the parent value when no move is possible. */
export function stepParam(current, spec, dir, sigma) {
  if (spec.type === 'int' && spec.scale === 'linear') {
    const step = Math.max(1, Math.round(sigma * (spec.max - spec.min)));
    return Math.min(spec.max, Math.max(spec.min, Math.round(current) + dir * step));
  }
  return fromUnit(toUnit(current, spec) + dir * sigma, spec);
}

/**
 * Drop-in replacement for upstream `mutateGenome` (same signature and return
 * shape), changing exactly one parameter. Deterministic in (seed, generation, index).
 */
export function mutateGenome(parent, genomeSpec, seed, generation, index, sigma) {
  calls += 1;
  const names = Object.keys(genomeSpec);
  const out = {};
  for (const name of names) {
    out[name] = parent[name] ?? defaultGenome({ [name]: genomeSpec[name] })[name];
  }
  if (names.length === 0) return { genome: out, mutatedParams: [] };
  const step = Number.isFinite(sigma) && sigma > 0 ? sigma : 0.2;
  const start = (hash(seed, generation, 'one-param-axis') + index) % names.length;
  const firstDir = coin(hash(seed, generation, index, 'one-param-dir')) ? 1 : -1;
  for (let k = 0; k < names.length; k++) {
    const name = names[(start + k) % names.length];
    const spec = genomeSpec[name];
    for (const dir of [firstDir, -firstDir]) {
      const next = stepParam(out[name], spec, dir, step);
      if (Number.isFinite(next) && next !== out[name]) {
        out[name] = next;
        return { genome: out, mutatedParams: [name] };
      }
    }
  }
  return { genome: out, mutatedParams: [] };
}

/**
 * Invariant check over an evolveNumeric archive: every non-baseline record must
 * differ from its parent in exactly one genome key, and that key must be the
 * one recorded in `mutatedParams`. Returns a list of violations (empty = ok).
 */
export function oneParamViolations(records) {
  const byId = new Map(records.map(r => [r.variant.id, r]));
  const violations = [];
  for (const { variant } of records) {
    if (variant.parentId === null) continue;
    const parent = byId.get(variant.parentId);
    if (!parent) { violations.push(`${variant.id}: parent ${variant.parentId} missing`); continue; }
    const keys = new Set([...Object.keys(variant.genome), ...Object.keys(parent.variant.genome)]);
    const changed = [...keys].filter(k => variant.genome[k] !== parent.variant.genome[k]);
    const recorded = variant.mutatedParams ?? [];
    if (changed.length !== 1 || recorded.length !== 1 || recorded[0] !== changed[0]) {
      violations.push(`${variant.id}: changed [${changed.join(', ')}], recorded [${recorded.join(', ')}]`);
    }
  }
  return violations;
}
