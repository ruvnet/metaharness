// @metaharness/evals-hle — the DATA CONTRACT (four immutable sets) + manifests.
//
// Anti-overfit is procedural. Four disjoint sets, each with a role the machinery ENFORCES:
//   publicDev        — debugging only; NEVER mutated against, NEVER promoted on. Also the leakage corpus.
//   privateTrain     — the proposer searches policy mutations here.
//   privateValidation— the promotion gate scores here.
//   frozenHoldout    — NEVER visible to proposer/mutation/tuning; confirmed against EXACTLY ONCE, at the end.
// Each set is content-hashed; the hashes go in the replay bundle so a reviewer can prove the split was fixed.
//
// The real corpus is HuggingFace `cais/hle` — a GATED dataset (a human must accept its terms at
// huggingface.co/datasets/cais/hle before any token can read it). `loadHleFromHub` reads it once access is
// granted; until then, the adapter runs on a clearly-labelled SYNTHETIC fixture (dataSource 'SYNTHETIC') so
// nothing here ever fabricates a real HLE score.
import { createHash } from 'node:crypto';
import type { AnswerFormat, Subject } from './genome.js';

export interface HleItem {
  id: string;
  question: string;
  /** Gold answer (closed-form → exact-match; open-ended → an injected LLM judge, never fabricated). */
  answer: string;
  answerFormat: AnswerFormat;
  /** Dataset category hint (feeds the classifier); optional. */
  category?: string;
  subject?: Subject;
  /** True when the gold answer is open-ended (needs a judge, not exact-match). */
  openEnded?: boolean;
}

export interface HleSplit {
  publicDev: HleItem[];
  privateTrain: HleItem[];
  privateValidation: HleItem[];
  frozenHoldout: HleItem[];
}

export interface SplitManifest {
  sizes: Record<keyof HleSplit, number>;
  hashes: Record<keyof HleSplit, string>;
  /** sha256 over all four hashes — the single split fingerprint for the replay bundle. */
  splitFingerprint: string;
}

export function hashItems(items: HleItem[]): string {
  const canon = items
    .map((i) => `${i.id}␟${i.question}␟${i.answer}␟${i.answerFormat}`)
    .sort()
    .join('␞');
  return createHash('sha256').update(canon).digest('hex');
}

export function manifestOf(split: HleSplit): SplitManifest {
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

/** Deterministic hash-sorted disjoint split (no RNG — reproducible + reviewable). Ratios follow the spec's
 *  ideal-first-experiment shape; the frozen holdout is carved FIRST so it never depends on the others. */
export function splitDeterministic(
  items: HleItem[],
  ratios: { publicDev: number; privateTrain: number; privateValidation: number; frozenHoldout: number } = {
    publicDev: 0.1, privateTrain: 0.5, privateValidation: 0.25, frozenHoldout: 0.15,
  },
): HleSplit {
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
export function isDisjoint(split: HleSplit): boolean {
  const ids = [
    ...split.publicDev, ...split.privateTrain, ...split.privateValidation, ...split.frozenHoldout,
  ].map((i) => i.id);
  return new Set(ids).size === ids.length;
}

/** Loader for the real gated corpus. Throws a clear, actionable error until HF access is granted — never
 *  silently substitutes synthetic data for a real run. */
export async function loadHleFromHub(_opts: { token: string; limit?: number }): Promise<HleItem[]> {
  throw new Error(
    'cais/hle is a GATED HuggingFace dataset. Grant access at https://huggingface.co/datasets/cais/hle ' +
      '(a human must accept the terms), then this loader can read it with a valid HF token. Until then, run ' +
      "the adapter on the SYNTHETIC fixture (dataSource 'SYNTHETIC') — it never fabricates a real HLE score.",
  );
}
