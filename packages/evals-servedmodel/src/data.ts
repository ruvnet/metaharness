// @metaharness/evals-servedmodel — the DATA CONTRACT (four immutable sets) + manifests.
//
// Same anti-overfit discipline as `@metaharness/evals-hle`: four disjoint, content-hashed sets.
//   publicDev         — used as the flywheel ANCHOR suite (never optimized against). A policy that
//                        regresses it has forgotten retained capability — the anti-Goodhart guard.
//   privateTrain      — the proposer searches serving-policy mutations here (not used by the $0 test).
//   privateValidation — the promotion gate scores candidates here (the flywheel `holdout`).
//   frozenHoldout     — never visible to proposer/tuning; confirmed against EXACTLY ONCE, at the end.
//
// Each AdaptationTask represents one interaction the served model handles. `capabilityClass` is the
// load-bearing field: 'core' items model the model's PRE-EXISTING capability (what EWC++ protects — a
// serving policy that drifts these downward has forgotten, not learned); 'domain' items model the live,
// interaction-specific stream the SONA/MicroLoRA micro-loop is actively adapting toward.
import { createHash } from 'node:crypto';

export interface AdaptationTask {
  id: string;
  capabilityClass: 'core' | 'domain';
  /** Descriptive only — an optional example prompt; never inspected by scoring, matches HLE's category hint. */
  prompt?: string;
}

export interface AdaptationSplit {
  publicDev: AdaptationTask[];
  privateTrain: AdaptationTask[];
  privateValidation: AdaptationTask[];
  frozenHoldout: AdaptationTask[];
}

export interface SplitManifest {
  sizes: Record<keyof AdaptationSplit, number>;
  hashes: Record<keyof AdaptationSplit, string>;
  splitFingerprint: string;
}

export function hashItems(items: AdaptationTask[]): string {
  const canon = items.map((i) => `${i.id}␟${i.capabilityClass}`).sort().join('␞');
  return createHash('sha256').update(canon).digest('hex');
}

export function manifestOf(split: AdaptationSplit): SplitManifest {
  const hashes = {
    publicDev: hashItems(split.publicDev),
    privateTrain: hashItems(split.privateTrain),
    privateValidation: hashItems(split.privateValidation),
    frozenHoldout: hashItems(split.frozenHoldout),
  };
  const sizes = {
    publicDev: split.publicDev.length,
    privateTrain: split.privateTrain.length,
    privateValidation: split.privateValidation.length,
    frozenHoldout: split.frozenHoldout.length,
  };
  const splitFingerprint = createHash('sha256')
    .update([hashes.publicDev, hashes.privateTrain, hashes.privateValidation, hashes.frozenHoldout].join('␞'))
    .digest('hex');
  return { sizes, hashes, splitFingerprint };
}

/** Deterministic hash-sorted disjoint split — no RNG, reproducible + reviewable. The frozen holdout is
 *  carved FIRST so it never depends on the others (mirrors evals-hle's `splitDeterministic`). */
export function splitDeterministic(
  items: AdaptationTask[],
  ratios: { publicDev: number; privateTrain: number; privateValidation: number; frozenHoldout: number } = {
    publicDev: 0.1, privateTrain: 0.5, privateValidation: 0.25, frozenHoldout: 0.15,
  },
): AdaptationSplit {
  const sorted = [...items].sort((a, b) =>
    createHash('sha256').update(a.id).digest('hex') < createHash('sha256').update(b.id).digest('hex') ? -1 : 1,
  );
  const n = sorted.length;
  const nHold = Math.max(0, Math.round(n * ratios.frozenHoldout));
  const nVal = Math.max(0, Math.round(n * ratios.privateValidation));
  const nDev = Math.max(0, Math.round(n * ratios.publicDev));
  const frozenHoldout = sorted.slice(0, nHold);
  const privateValidation = sorted.slice(nHold, nHold + nVal);
  const publicDev = sorted.slice(nHold + nVal, nHold + nVal + nDev);
  const privateTrain = sorted.slice(nHold + nVal + nDev);
  return { publicDev, privateTrain, privateValidation, frozenHoldout };
}

/** True iff the four sets are pairwise disjoint by id — an invariant the machinery must hold. */
export function isDisjoint(split: AdaptationSplit): boolean {
  const ids = [...split.publicDev, ...split.privateTrain, ...split.privateValidation, ...split.frozenHoldout].map((i) => i.id);
  return new Set(ids).size === ids.length;
}

/** Loader for a REAL ruvllm-served interaction log. Throws until a real log/export is wired — never
 *  silently substitutes synthetic data for a LIVE run (same discipline as evals-hle's `loadHleFromHub`). */
export async function loadServedInteractionLog(_opts: { source: string; limit?: number }): Promise<AdaptationTask[]> {
  throw new Error(
    'loadServedInteractionLog: no real ruvllm-served interaction log wired yet — this requires an actually ' +
      "running `ruvllm serve` instance with a loaded model (ADR-234 §1.1 notes wasm was uninitialized, no model " +
      "loaded, this session). Until a real serving log exists, run the adapter on the SYNTHETIC fixture " +
      "(dataSource 'SYNTHETIC') — it never fabricates a real served-model score.",
  );
}
