// @metaharness/evals-toolcall — the CALL-CATEGORY CLASSIFIER.
//
// Maps a query (+ its available tool count) to one of the fixed CATEGORIES so the verifier stack + selection
// style can be chosen per category. Default is a cheap deterministic heuristic (no model, no cost). An LLM
// classifier can be injected for the live run; the heuristic is the $0 fallback + the reproducible default for
// replay. The BFCL taxonomy: simple (one tool, one call), multiple (several tools, pick one), parallel (one
// query → several calls), parallelMultiple (several tools AND several calls), irrelevance (no tool applies).
import { CATEGORIES, type Category } from './genome.js';

export interface ClassifyContext {
  /** Number of candidate tools presented to the model for this query. */
  toolCount?: number;
  /** Number of gold calls expected (when known from a dataset hint). */
  expectedCalls?: number;
}

export type Classifier = (query: string, hintedCategory?: string, ctx?: ClassifyContext) => Category;

const IRRELEVANCE_RE = /\b(no (matching|available|suitable) (tool|function)|cannot|can'?t be done|not (possible|supported)|none of (the|these))\b/i;
// A query that asks for several distinct actions tends to need parallel calls.
const CONJUNCTION_RE = /\b(and then|and also|as well as|;| and )\b/i;

/** The default $0 heuristic classifier. Honors an explicit dataset category hint when present, else infers
 *  from the query shape + tool/expected-call counts. */
export const heuristicClassifier: Classifier = (query, hintedCategory, ctx) => {
  if (hintedCategory) {
    const h = hintedCategory.toLowerCase().replace(/[_\s-]/g, '');
    for (const c of CATEGORIES) if (c !== 'other' && h.includes(c.toLowerCase())) return c;
    if (/parallelmultiple/.test(h)) return 'parallelMultiple';
    if (/parallel/.test(h)) return 'parallel';
    if (/multiple|multi/.test(h)) return 'multiple';
    if (/irrelevanc|norel|reject/.test(h)) return 'irrelevance';
    if (/simple|single/.test(h)) return 'simple';
  }

  if (IRRELEVANCE_RE.test(query)) return 'irrelevance';

  const tools = ctx?.toolCount ?? 1;
  const calls = ctx?.expectedCalls ?? (CONJUNCTION_RE.test(query) ? 2 : 1);
  if (calls > 1 && tools > 1) return 'parallelMultiple';
  if (calls > 1) return 'parallel';
  if (tools > 1) return 'multiple';
  return 'simple';
};
