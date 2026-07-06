// @metaharness/evals-extract — the DATA CONTRACT (four immutable sets) + manifests.
//
// Anti-overfit is procedural. Four disjoint sets, each with a role the machinery ENFORCES:
//   publicDev        — debugging only; NEVER mutated against, NEVER promoted on. Also the leakage corpus.
//   privateTrain     — the proposer searches policy mutations here.
//   privateValidation— the promotion gate scores here.
//   frozenHoldout    — NEVER visible to proposer/mutation/tuning; confirmed against EXACTLY ONCE, at the end.
// Each set is content-hashed; the hashes go in the replay bundle so a reviewer can prove the split was fixed.
//
// A real extraction corpus (invoices/receipts/resumes/contracts with gold JSON per document) is typically
// LICENSED/gated — a human must accept its terms before any token can read it. `loadExtractFromHub` reads it
// once access is granted; until then, the adapter runs on a clearly-labelled SYNTHETIC fixture (dataSource
// 'SYNTHETIC') so nothing here ever fabricates a real extraction score.
import { createHash } from 'node:crypto';
import type { DocType } from './genome.js';
import type { JsonSchema } from './normalizer.js';

export interface ExtractItem {
  id: string;
  /** The source document text to extract from. */
  text: string;
  /** The JSON schema the extraction must conform to. */
  schema: JsonSchema;
  /** Gold extraction object (serialized JSON) — closed-form fields → exact-match; open-ended → injected LLM
   *  judge, never fabricated. */
  gold: string;
  /** Dataset category hint (feeds the classifier); optional. */
  category?: string;
  docType?: DocType;
  /** True when at least one gold field is open-ended free text (needs a judge, not field-exact-match). */
  openEnded?: boolean;
}

export interface ExtractSplit {
  publicDev: ExtractItem[];
  privateTrain: ExtractItem[];
  privateValidation: ExtractItem[];
  frozenHoldout: ExtractItem[];
}

export interface SplitManifest {
  sizes: Record<keyof ExtractSplit, number>;
  hashes: Record<keyof ExtractSplit, string>;
  /** sha256 over all four hashes — the single split fingerprint for the replay bundle. */
  splitFingerprint: string;
}

export function hashItems(items: ExtractItem[]): string {
  const canon = items
    .map((i) => `${i.id}␟${i.text}␟${i.gold}␟${JSON.stringify(i.schema)}`)
    .sort()
    .join('␞');
  return createHash('sha256').update(canon).digest('hex');
}

export function manifestOf(split: ExtractSplit): SplitManifest {
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

/** Deterministic hash-sorted disjoint split (no RNG — reproducible + reviewable). The frozen holdout is
 *  carved FIRST so it never depends on the others. */
export function splitDeterministic(
  items: ExtractItem[],
  ratios: { publicDev: number; privateTrain: number; privateValidation: number; frozenHoldout: number } = {
    publicDev: 0.1, privateTrain: 0.5, privateValidation: 0.25, frozenHoldout: 0.15,
  },
): ExtractSplit {
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
export function isDisjoint(split: ExtractSplit): boolean {
  const ids = [
    ...split.publicDev, ...split.privateTrain, ...split.privateValidation, ...split.frozenHoldout,
  ].map((i) => i.id);
  return new Set(ids).size === ids.length;
}

/** Loader for the real licensed corpus. Throws a clear, actionable error until access is granted — never
 *  silently substitutes synthetic data for a real run. */
export async function loadExtractFromHub(_opts: { token: string; dataset: string; limit?: number }): Promise<ExtractItem[]> {
  throw new Error(
    'A real structured-extraction corpus (documents + gold JSON) is a LICENSED/gated resource. Grant access ' +
      'to your chosen dataset and provide a valid token, then this loader can read it. Until then, run the ' +
      "adapter on the SYNTHETIC fixture (dataSource 'SYNTHETIC') — it never fabricates a real extraction score.",
  );
}
