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

/** Parse the GSM8K gold answer: the token after the final `#### ` marker, with `$`/commas/spaces stripped.
 *  GSM8K finals are integers. Returns null for anything that isn't a clean number — NEVER guesses a gold
 *  value (an unparseable row is dropped, not fabricated). */
export function parseGsm8kGold(rawAnswer: string): string | null {
  const m = String(rawAnswer ?? '').match(/####\s*([^\n]+?)\s*$/);
  if (!m) return null;
  const cleaned = m[1].replace(/[$,\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : null;
}

/** Loader for the real corpus (HuggingFace `openai/gsm8k`, test split) via the PUBLIC datasets-server rows
 *  API — no token required (a token is accepted for higher rate limits). Parses each row's `#### N` gold
 *  into a closed-form `integer` MathItem. Network-only + explicit: unit tests never call this (they use the
 *  SYNTHETIC fixture); the freeze script calls it ONCE and commits the hashed split. Never fabricates. */
export async function loadGsm8kFromHub(opts: { token?: string; limit?: number; split?: string } = {}): Promise<MathItem[]> {
  const limit = opts.limit ?? 300;
  const split = opts.split ?? 'test';
  const headers: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
  const items: MathItem[] = [];
  const PAGE = 100; // datasets-server caps `length` at 100 per request
  for (let offset = 0; offset < limit && items.length < limit; offset += PAGE) {
    const length = Math.min(PAGE, limit - offset);
    const url = `https://datasets-server.huggingface.co/rows?dataset=openai%2Fgsm8k&config=main&split=${split}&offset=${offset}&length=${length}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GSM8K load failed: HTTP ${res.status} at offset ${offset} (${(await res.text()).slice(0, 160)})`);
    const rows = ((await res.json()) as { rows?: Array<{ row_idx: number; row: { question: string; answer: string } }> }).rows ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      const gold = parseGsm8kGold(r.row.answer);
      if (gold === null) continue; // drop unparseable rows — never invent a gold answer
      items.push({ id: `gsm8k-${split}-${r.row_idx}`, question: r.row.question, answer: gold, answerFormat: 'integer' });
    }
  }
  if (items.length === 0) throw new Error('GSM8K load returned 0 parseable items — refusing to proceed with an empty corpus');
  return items;
}
