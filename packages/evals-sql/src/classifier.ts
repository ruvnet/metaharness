// @metaharness/evals-sql — the QUERY-TYPE CLASSIFIER.
//
// Maps a natural-language question to one of the fixed QUERY_TYPES so the verifier stack + SQL dialect can be
// chosen per type. Default is a cheap deterministic keyword heuristic (no model, no cost). An LLM classifier
// can be injected for the live run; the heuristic is the $0 fallback + the reproducible default for replay.
import { QUERY_TYPES, type QueryType } from './genome.js';

export type Classifier = (question: string, hintedCategory?: string) => QueryType;

const KEYWORDS: Record<Exclude<QueryType, 'other'>, RegExp> = {
  aggregate: /\b(how many|count|number of|total|sum of|average|avg|mean|maximum|minimum|max\b|min\b|largest|smallest)\b/i,
  join: /\b(along with|as well as|together with|and their|and its|for each .* who|belonging to|associated with)\b/i,
  nested: /\b(more than the|greater than any|less than any|at least as|that have not|which do not|other than the|no fewer than)\b/i,
  groupby: /\b(for each|per\b|grouped by|by each|breakdown|respectively|for every)\b/i,
  orderby: /\b(sorted|ordered|top \d|highest|lowest|first \d|last \d|descending|ascending|ranked|most|least)\b/i,
  setops: /\b(union|intersect|except|in both|not in|neither|either .* or|that are (also|not))\b/i,
  select: /\b(list|show|what are|find all|give me|names of|display|retrieve|return all)\b/i,
};

/** The default $0 heuristic classifier. Honors an explicit dataset category hint when present. */
export const heuristicClassifier: Classifier = (question, hintedCategory) => {
  if (hintedCategory) {
    const h = hintedCategory.toLowerCase();
    for (const t of QUERY_TYPES) if (t !== 'other' && h.includes(t)) return t;
    if (/agg|count|sum|avg/.test(h)) return 'aggregate';
    if (/group/.test(h)) return 'groupby';
    if (/order|sort|rank/.test(h)) return 'orderby';
    if (/union|intersect|except|set/.test(h)) return 'setops';
    if (/sub|nest/.test(h)) return 'nested';
    if (/join/.test(h)) return 'join';
  }
  for (const [type, re] of Object.entries(KEYWORDS)) if (re.test(question)) return type as QueryType;
  return 'other';
};
