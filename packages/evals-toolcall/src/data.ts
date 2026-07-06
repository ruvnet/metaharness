// @metaharness/evals-toolcall — the DATA CONTRACT (four immutable sets) + manifests.
//
// Anti-overfit is procedural. Four disjoint sets, each with a role the machinery ENFORCES:
//   publicDev        — debugging only; NEVER mutated against, NEVER promoted on. Also the leakage corpus.
//   privateTrain     — the proposer searches policy mutations here.
//   privateValidation— the promotion gate scores here.
//   frozenHoldout    — NEVER visible to proposer/mutation/tuning; confirmed against EXACTLY ONCE, at the end.
// Each set is content-hashed; the hashes go in the replay bundle so a reviewer can prove the split was fixed.
//
// The real corpus is the Berkeley Function-Calling Leaderboard (BFCL / gorilla). `loadBfclFromHub` reads it
// once the caller supplies a source; until then, the adapter runs on a clearly-labelled SYNTHETIC fixture
// (dataSource 'SYNTHETIC') so nothing here ever fabricates a real BFCL score.
import { createHash } from 'node:crypto';
import type { ArgFormat, Category } from './genome.js';
import type { ToolCall } from './normalizer.js';
import type { ToolSchema } from './verifier.js';

export interface ToolItem {
  id: string;
  query: string;
  /** The candidate tools presented to the model (their schemas). */
  tools: ToolSchema[];
  /** The gold function call (name + args) the query should produce. */
  goldCall: ToolCall;
  /** How gold args should be canonicalized for matching. */
  argFormat: ArgFormat;
  /** Dataset category hint (feeds the classifier); optional. */
  categoryHint?: string;
  category?: Category;
  /** True when the query is an IRRELEVANCE case — the correct output is NO call (abstain). */
  irrelevant?: boolean;
}

export interface ToolSplit {
  publicDev: ToolItem[];
  privateTrain: ToolItem[];
  privateValidation: ToolItem[];
  frozenHoldout: ToolItem[];
}

export interface SplitManifest {
  sizes: Record<keyof ToolSplit, number>;
  hashes: Record<keyof ToolSplit, string>;
  /** sha256 over all four hashes — the single split fingerprint for the replay bundle. */
  splitFingerprint: string;
}

export function hashItems(items: ToolItem[]): string {
  const canon = items
    .map((i) => `${i.id}␟${i.query}␟${i.goldCall.name}(${stableArgs(i.goldCall.args)})␟${i.argFormat}`)
    .sort()
    .join('␞');
  return createHash('sha256').update(canon).digest('hex');
}

function stableArgs(args: Record<string, unknown>): string {
  return Object.keys(args).sort().map((k) => `${k}=${JSON.stringify(args[k])}`).join(',');
}

export function manifestOf(split: ToolSplit): SplitManifest {
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
  items: ToolItem[],
  ratios: { publicDev: number; privateTrain: number; privateValidation: number; frozenHoldout: number } = {
    publicDev: 0.1, privateTrain: 0.5, privateValidation: 0.25, frozenHoldout: 0.15,
  },
): ToolSplit {
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
export function isDisjoint(split: ToolSplit): boolean {
  const ids = [
    ...split.publicDev, ...split.privateTrain, ...split.privateValidation, ...split.frozenHoldout,
  ].map((i) => i.id);
  return new Set(ids).size === ids.length;
}

/** Loader for the real BFCL corpus. Throws a clear, actionable error until a source is wired — never
 *  silently substitutes synthetic data for a real run. */
export async function loadBfclFromHub(_opts: { source: string; limit?: number }): Promise<ToolItem[]> {
  throw new Error(
    'The Berkeley Function-Calling Leaderboard (gorilla-llm/BFCL) is the real corpus. Wire a concrete source ' +
      '(the published BFCL question/answer files) into this loader before any live run. Until then, run the ' +
      "adapter on the SYNTHETIC fixture (dataSource 'SYNTHETIC') — it never fabricates a real BFCL score.",
  );
}
