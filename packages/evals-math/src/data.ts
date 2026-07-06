// @metaharness/evals-math — the DATA CONTRACT (four immutable sets) + manifests.
//
// Anti-overfit is procedural. Four disjoint sets, each with a role the machinery ENFORCES:
//   publicDev        — debugging only; NEVER mutated against, NEVER promoted on. Also the leakage corpus.
//   privateTrain     — the proposer searches policy mutations here.
//   privateValidation— the promotion gate scores here.
//   frozenHoldout    — NEVER visible to proposer/mutation/tuning; confirmed against EXACTLY ONCE, at the end.
// Each set is content-hashed; the hashes go in the replay bundle so a reviewer can prove the split was fixed.
//
// The real corpus is HuggingFace `openai/gsm8k` (the GSM8K grade-school-math test split). `loadGsm8kFromHub`
// reads it once a token/network is available; until then, the adapter runs on a clearly-labelled SYNTHETIC
// fixture (dataSource 'SYNTHETIC') so nothing here ever fabricates a real GSM8K score.
import { createHash } from 'node:crypto';
import type { AnswerFormat, Subject } from './genome.js';

export interface MathItem {
  id: string;
  question: string;
  /** Gold answer (GSM8K → the numeric final answer after the `####` marker; graded by exact-match). */
  answer: string;
  answerFormat: AnswerFormat;
  /** Dataset category hint (feeds the classifier); optional. */
  category?: string;
  subject?: Subject;
  /** True when the gold answer is open-ended (needs a judge, not exact-match). Rare for GSM8K. */
  openEnded?: boolean;
}

export interface MathSplit {
  publicDev: MathItem[];
  privateTrain: MathItem[];
  privateValidation: MathItem[];
  frozenHoldout: MathItem[];
}

export interface SplitManifest {
  sizes: Record<keyof MathSplit, number>;
  hashes: Record<keyof MathSplit, string>;
  /** sha256 over all four hashes — the single split fingerprint for the replay bundle. */
  splitFingerprint: string;
}

export function hashItems(items: MathItem[]): string {
  const canon = items
    .map((i) => `${i.id}␟${i.question}␟${i.answer}␟${i.answerFormat}`)
    .sort()
    .join('␞');
  return createHash('sha256').update(canon).digest('hex');
}

export function manifestOf(split: MathSplit): SplitManifest {
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
  items: MathItem[],
  ratios: { publicDev: number; privateTrain: number; privateValidation: number; frozenHoldout: number } = {
    publicDev: 0.1, privateTrain: 0.5, privateValidation: 0.25, frozenHoldout: 0.15,
  },
): MathSplit {
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
export function isDisjoint(split: MathSplit): boolean {
  const ids = [
    ...split.publicDev, ...split.privateTrain, ...split.privateValidation, ...split.frozenHoldout,
  ].map((i) => i.id);
  return new Set(ids).size === ids.length;
}

/** Loader for the real corpus. Throws a clear, actionable error until a token/network is wired — never
 *  silently substitutes synthetic data for a real run. */
export async function loadGsm8kFromHub(_opts: { token?: string; limit?: number }): Promise<MathItem[]> {
  throw new Error(
    'openai/gsm8k must be loaded over the network (a valid HuggingFace token + connectivity are required, ' +
      'and the extracted `#### N` gold answers parsed). Wire that in for a LIVE run; until then, run the ' +
      "adapter on the SYNTHETIC fixture (dataSource 'SYNTHETIC') — it never fabricates a real GSM8K score.",
  );
}
