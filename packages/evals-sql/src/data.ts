// @metaharness/evals-sql — the DATA CONTRACT (four immutable sets) + manifests.
//
// Anti-overfit is procedural. Four disjoint sets, each with a role the machinery ENFORCES:
//   publicDev        — debugging only; NEVER mutated against, NEVER promoted on. Also the leakage corpus.
//   privateTrain     — the proposer searches policy mutations here.
//   privateValidation— the promotion gate scores here.
//   frozenHoldout    — NEVER visible to proposer/mutation/tuning; confirmed against EXACTLY ONCE, at the end.
// Each set is content-hashed; the hashes go in the replay bundle so a reviewer can prove the split was fixed.
//
// The real corpus is a Spider-style text-to-SQL dataset (question + gold SQL + DB schema). `loadSqlFromHub`
// reads it once access + a local DB copy are provisioned; until then, the adapter runs on a clearly-labelled
// SYNTHETIC fixture (dataSource 'SYNTHETIC') so nothing here ever fabricates a real execution-match score.
import { createHash } from 'node:crypto';
import type { SqlDialect, QueryType } from './genome.js';

export interface SqlItem {
  id: string;
  question: string;
  /** Gold SQL (execution-match on the live run; canonical exact-match for the $0 SYNTHETIC replay). */
  gold: string;
  /** The DB's native dialect (drives normalization/quoting); defaults to sqlite. */
  dialect: SqlDialect;
  /** Database/schema identifier the question is grounded in; optional. */
  dbId?: string;
  /** Dataset query-type hint (feeds the classifier); optional. */
  category?: string;
  queryType?: QueryType;
  /** True when the gold cannot be exact-matched and needs execution-compare (never fabricated). */
  openEnded?: boolean;
}

export interface SqlSplit {
  publicDev: SqlItem[];
  privateTrain: SqlItem[];
  privateValidation: SqlItem[];
  frozenHoldout: SqlItem[];
}

export interface SplitManifest {
  sizes: Record<keyof SqlSplit, number>;
  hashes: Record<keyof SqlSplit, string>;
  /** sha256 over all four hashes — the single split fingerprint for the replay bundle. */
  splitFingerprint: string;
}

export function hashItems(items: SqlItem[]): string {
  const canon = items
    .map((i) => `${i.id}␟${i.question}␟${i.gold}␟${i.dialect}`)
    .sort()
    .join('␞');
  return createHash('sha256').update(canon).digest('hex');
}

export function manifestOf(split: SqlSplit): SplitManifest {
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
  items: SqlItem[],
  ratios: { publicDev: number; privateTrain: number; privateValidation: number; frozenHoldout: number } = {
    publicDev: 0.1, privateTrain: 0.5, privateValidation: 0.25, frozenHoldout: 0.15,
  },
): SqlSplit {
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
export function isDisjoint(split: SqlSplit): boolean {
  const ids = [
    ...split.publicDev, ...split.privateTrain, ...split.privateValidation, ...split.frozenHoldout,
  ].map((i) => i.id);
  return new Set(ids).size === ids.length;
}

/** Loader for the real corpus. Throws a clear, actionable error until the dataset + a local DB copy are
 *  provisioned — never silently substitutes synthetic data for a real run. */
export async function loadSqlFromHub(_opts: { token?: string; dbDir?: string; limit?: number }): Promise<SqlItem[]> {
  throw new Error(
    'A real text-to-SQL run needs (1) the Spider-style dataset (question + gold SQL + schema) and (2) a local ' +
      'copy of the databases so execution-match can actually run the queries. Provision both, then this loader ' +
      "can read them. Until then, run the adapter on the SYNTHETIC fixture (dataSource 'SYNTHETIC') — it never " +
      'fabricates a real execution-match score.',
  );
}
