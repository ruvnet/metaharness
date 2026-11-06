// SPDX-License-Identifier: MIT
//
// Memory subsystem TS bridge.
//
// Per ADR-006, the kernel exposes the memory BRIDGE API. The actual vector
// store is AgentDB-backed; the kernel adds DECAY-WEIGHTED scoring on top of
// raw cosine similarity, driven by `@ruvector/emergent-time@0.1.0`.
//
// The integration follows the per-API mapping table in ADR-006:
//   - AgenticClock        -> per-memory decay weight (HNSW score multiplier)
//   - WindowedDeltaClock  -> trajectory-step weighting (intel pipeline)
//   - PageHinkleyDetector -> change-point trigger for DISTILL phase firing
//   - LearnedWeights      -> reserved for self-evolution (iter 7+, ADR-014)
//
// All four exports come from the same npm package the user shipped
// today: https://www.npmjs.com/package/@ruvector/emergent-time
//
// Honesty caveat (from the @ruvector/emergent-time README): the SDK is
// "diagnostic signal, no proven early-warning lead over a fair baseline".
// So we gate the decay-weighted path behind a feature flag and ALWAYS
// preserve the raw cosine score so callers can compare.

export interface MemoryHit {
  /** Memory entry id. */
  id: string;
  /** Raw cosine similarity (0..1) — what HNSW returned. */
  score: number;
  /**
   * Decay-weighted score. When emergent-time isn't loaded, equals `score`.
   * When loaded, multiplied by the AgenticClock weight for the entry's age.
   */
  decayedScore: number;
  /** Namespace the hit lives in. */
  namespace: string;
  /** When this entry was stored (ms since epoch). */
  storedAt?: number;
}

export interface DecayConfig {
  /** Reference timestamp for "now" (ms). Defaults to Date.now() at query time. */
  now?: number;
  /** When true, returns hits ranked by decayedScore. When false, by score. */
  useDecay?: boolean;
  /**
   * Half-life in milliseconds — at this age, decay weight is 0.5. The
   * AgenticClock translates this into a six-channel structural-proper-time
   * estimate; we surface only the resulting weight here.
   */
  halfLifeMs?: number;
}

interface EmergentTimeApi {
  AgenticClock: new (config: { halfLifeMs: number }) => { weight(ageMs: number): number };
  PageHinkleyDetector: new (config?: { delta?: number; threshold?: number }) =>
    { feed(value: number): { changePoint: boolean; magnitude: number } };
}

let _emergent: EmergentTimeApi | null | undefined;

async function loadEmergent(): Promise<EmergentTimeApi | null> {
  if (_emergent !== undefined) return _emergent;
  try {
    const mod = await import('@ruvector/emergent-time') as unknown as EmergentTimeApi;
    // Probe-construct an AgenticClock to confirm WASM is actually initialised.
    // The dynamic-import resolves the JS shim even when the underlying WASM
    // bindings haven't been bootstrapped, so a present-module check isn't
    // enough — the constructor throws on first use ("Cannot read properties
    // of undefined (reading 'agenticclock_new')"). Probe + discard catches
    // that case and routes the caller to its raw-score fallback.
    new mod.AgenticClock({ halfLifeMs: 1000 });
    _emergent = mod;
    return mod;
  } catch {
    _emergent = null;
    return null;
  }
}

/** An emergent-time clock with a callable `weight(ageMs)`, or null. */
async function emergentDecayClock(halfLifeMs: number): Promise<{ weight(ageMs: number): number } | null> {
  const emergent = await loadEmergent();
  if (!emergent) return null;
  try {
    const clock = new emergent.AgenticClock({ halfLifeMs }) as { weight?: unknown };
    return typeof clock.weight === 'function' ? (clock as { weight(ageMs: number): number }) : null;
  } catch {
    return null;
  }
}

/**
 * Rank a list of raw HNSW hits by decay-weighted score when `useDecay` is
 * true: an emergent-time AgenticClock weight when one is usable, otherwise
 * the half-life weight `linearDecay(age, halfLifeMs)`.
 *
 * Returns a NEW array sorted descending by decayedScore (when useDecay=true)
 * or score (when false).
 */
export async function rankWithDecay(
  hits: MemoryHit[],
  config: DecayConfig = {},
): Promise<MemoryHit[]> {
  const now = config.now ?? Date.now();
  const useDecay = config.useDecay ?? true;
  const halfLifeMs = config.halfLifeMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days

  if (!useDecay) {
    return [...hits].sort((a, b) => b.score - a.score);
  }

  // Without a usable emergent-time clock, decay with the deterministic
  // half-life weight 0.5^(age / halfLifeMs). `score` stays raw. Until 0.1.6
  // this path returned raw scores, so decay never reordered anything:
  // @ruvector/emergent-time 0.1.x has no `weight(ageMs)` (its AgenticClock
  // measures internal agent time from state deltas, not age decay).
  const clock = (await emergentDecayClock(halfLifeMs))
    ?? { weight: (ageMs: number) => linearDecay(ageMs, halfLifeMs) };
  // Hits without `storedAt` are treated as age 0 (weight 1).
  const ranked = hits.map(h => {
    const ageMs = h.storedAt !== undefined ? Math.max(0, now - h.storedAt) : 0;
    const weight = clock.weight(ageMs);
    return { ...h, decayedScore: h.score * weight };
  });
  ranked.sort((a, b) => b.decayedScore - a.decayedScore);
  return ranked;
}

/**
 * Change-point trigger for the DISTILL phase. Feeds a stream of
 * trajectory-success scores into PageHinkleyDetector; when the detector
 * fires, the intel pipeline kicks DISTILL.
 *
 * Returns a callable that consumes scores one at a time.
 */
export async function distillTrigger(opts: { threshold?: number; delta?: number } = {}): Promise<
  (score: number) => { changePoint: boolean; magnitude: number }
> {
  const emergent = await loadEmergent();
  if (!emergent) {
    // Fallback: never fire. Caller's DISTILL phase still runs on its
    // threshold-based gate.
    return (_score: number) => ({ changePoint: false, magnitude: 0 });
  }
  const detector = new emergent.PageHinkleyDetector(opts);
  return (score: number) => detector.feed(score);
}

/**
 * Linear decay function for tests / fallback paths that need a simple
 * deterministic weight without loading emergent-time.
 */
export function linearDecay(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0) return 1;
  const halves = ageMs / halfLifeMs;
  return Math.pow(0.5, halves);
}
