// SPDX-License-Identifier: MIT
//
// Clade-metaproductivity parent selection (ADR-094), after the Huxley-Gödel
// Machine (Wang, Piękos, Li et al., arXiv:2510.21614, 2025). It fixes the
// "metaproductivity–performance mismatch": the best-SCORING variant is a poor
// PARENT because it has exhausted its descendant diversity. HGM instead selects
// parents by Clade Metaproductivity — the success rate of a variant's whole
// descendant subtree — via Thompson sampling over Beta(τ·passes+1, τ·fails+1),
// with τ scheduling exploration→exploitation.
//
// We tie τ to the SGM risk budget (ADR-090): early (budget full) → low τ → flat
// Betas → exploration; late (budget spent) → high τ → sharp Betas → exploitation.
//
// Unlike the paper (which uses Math.random), the Beta draws here come from a
// SEEDED PRNG, so clade selection is fully reproducible (ADR-075) — same seed ⇒
// same parents. Dependency-free.

import type { Archive } from './archive.js';
import type { HarnessVariant } from './types.js';

/** mulberry32 — a tiny, fast, deterministic PRNG seeded from a 32-bit integer. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller from a uniform stream. */
function sampleNormal(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape ≥ 1, scale 1) via Marsaglia–Tsang. Our shapes are always ≥ 1. */
function sampleGamma(rng: () => number, shape: number): number {
  const k = Math.max(1, shape);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = sampleNormal(rng);
    const v0 = 1 + c * x;
    if (v0 <= 0) continue;
    const v = v0 * v0 * v0;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta(a, b) = X/(X+Y), X~Gamma(a), Y~Gamma(b). Deterministic given `rng`. */
export function sampleBeta(rng: () => number, a: number, b: number): number {
  const x = sampleGamma(rng, a);
  const y = sampleGamma(rng, b);
  return x + y === 0 ? 0.5 : x / (x + y);
}

/**
 * Clade outcome counts over a variant's descendant subtree (inclusive). A scored
 * node is a "success" iff it was promoted, else a "failure"; unscored nodes are
 * ignored. Cycle-guarded. O(subtree).
 */
export function cladeOutcomes(archive: Archive, rootId: string): { passes: number; failures: number } {
  let passes = 0, failures = 0;
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const rec = archive.get(id);
    if (!rec) continue;
    if (rec.score !== null) {
      if (rec.score.promoted) passes += 1;
      else failures += 1;
    }
    for (const child of rec.children) stack.push(child);
  }
  return { passes, failures };
}

/**
 * `cladeOutcomes` for EVERY node in the archive at once, via a single
 * bottom-up (post-order) pass instead of one full subtree walk per node.
 * `cladeThompsonSelect` used to call `cladeOutcomes` once per scored record —
 * O(n) per call, O(n) calls, so O(n * avg-subtree-size) total, which degrades
 * to O(n²) on a roughly linear lineage (each generation's subtree walk almost
 * entirely re-walks its parent's). Here, each node's subtree outcome is its
 * own outcome plus the sum of its already-computed children — so every node
 * and every parent-child edge is visited exactly once, O(n) total.
 *
 * Memoized recursion, not a naive DFS: a node revisited while still "in
 * progress" (`visiting`) contributes zero from that edge — the same cycle
 * defense `cladeOutcomes`'s `seen` set gives a single walk. The archive is a
 * tree/forest by construction (`Archive.addVariant` only appends a child once
 * its parent already exists), so this should never trigger in practice.
 */
function cladeOutcomesAll(archive: Archive): Map<string, { passes: number; failures: number }> {
  const records = archive.all();

  // Fast path: `addVariant` only wires a child edge once its parent exists, so
  // insertion order is topological (parents before children). One REVERSE pass
  // computes every subtree total with children always ready — no recursion, no
  // visiting set, O(n). If the archive was loaded from a hand-edited file that
  // violates that order (a child inserted before its parent), fall back to the
  // cycle-guarded memoized walk below.
  const memo = new Map<string, { passes: number; failures: number }>();
  let ordered = true;
  outer: for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    let passes = 0, failures = 0;
    if (rec.score !== null) {
      if (rec.score.promoted) passes += 1;
      else failures += 1;
    }
    for (const child of rec.children) {
      const c = memo.get(child);
      if (c === undefined) {
        if (archive.get(child) === undefined) continue; // dangling edge — ignore
        ordered = false; // child inserted before parent — cannot trust the pass
        break outer;
      }
      passes += c.passes;
      failures += c.failures;
    }
    memo.set(rec.variant.id, { passes, failures });
  }
  if (ordered) return memo;

  // Slow path (out-of-order archive): memoized recursion with a cycle guard.
  memo.clear();
  const visiting = new Set<string>();

  function compute(id: string): { passes: number; failures: number } {
    const cached = memo.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return { passes: 0, failures: 0 }; // cycle guard, see doc above
    visiting.add(id);
    let passes = 0, failures = 0;
    const rec = archive.get(id);
    if (rec) {
      if (rec.score !== null) {
        if (rec.score.promoted) passes += 1;
        else failures += 1;
      }
      for (const child of rec.children) {
        const c = compute(child);
        passes += c.passes;
        failures += c.failures;
      }
    }
    visiting.delete(id);
    const result = { passes, failures };
    memo.set(id, result);
    return result;
  }

  for (const rec of records) compute(rec.variant.id);
  return memo;
}

/** Per-archive outcome-table cache, invalidated by {@link Archive.revision}.
 *  Selection is often called several times against an unchanged archive (one
 *  call per surface / per tau step within a generation); the table only
 *  depends on the archive contents, so equal revisions ⇒ reuse. */
const outcomesCache = new WeakMap<Archive, { revision: number; outcomes: Map<string, { passes: number; failures: number }> }>();

function cladeOutcomesCached(archive: Archive): Map<string, { passes: number; failures: number }> {
  const hit = outcomesCache.get(archive);
  if (hit && hit.revision === archive.revision) return hit.outcomes;
  const outcomes = cladeOutcomesAll(archive);
  outcomesCache.set(archive, { revision: archive.revision, outcomes });
  return outcomes;
}

/**
 * Clade-metaproductivity Thompson selection: for every scored variant draw
 * `u ~ Beta(τ·passes+1, τ·failures+1)` over its subtree outcomes and return the
 * top-`limit` variants by `u`. Seeded → reproducible. Returns `[]` when nothing
 * is scored (caller falls back).
 *
 * @param tau exploration→exploitation schedule in [0, ∞): 0 ⇒ uniform Beta(1,1)
 *   (pure exploration); larger ⇒ sharper posteriors (exploitation).
 */
export function cladeThompsonSelect(
  archive: Archive,
  tau: number,
  limit: number,
  seed: number,
): HarnessVariant[] {
  if (limit <= 0) return [];
  const rng = mulberry32(seed);
  const t = Math.max(0, tau);
  const scored = archive.all().filter((r) => r.score !== null);
  if (scored.length === 0) return [];
  const outcomes = cladeOutcomesCached(archive);

  // Single pass keeping only the top-`limit` draws (limit is small — typically
  // 2-8 parents — so insertion into a short sorted array beats the former full
  // O(n log n) sort). Order matches the previous stable sort exactly: higher u
  // first, ties toward the earlier insertion index — and the rng draw sequence
  // is unchanged, so a fixed seed selects identical parents.
  const top: Array<{ variant: HarnessVariant; u: number; index: number }> = [];
  for (let index = 0; index < scored.length; index++) {
    const r = scored[index];
    const { passes, failures } = outcomes.get(r.variant.id) ?? { passes: 0, failures: 0 };
    const u = sampleBeta(rng, t * passes + 1, t * failures + 1);
    if (top.length === limit && u <= top[top.length - 1].u) continue; // ties keep the earlier entry
    let at = top.length;
    while (at > 0 && top[at - 1].u < u) at -= 1;
    top.splice(at, 0, { variant: r.variant, u, index });
    if (top.length > limit) top.pop();
  }
  return top.map((x) => x.variant);
}
